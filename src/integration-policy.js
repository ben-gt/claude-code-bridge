import { createHash } from 'node:crypto';
import { addSecret } from './scrub.js';
import { parseRemote } from './git.js';
import { hostConfigFor, apiFetch, credentialFor } from './credentials.js';

export function branchName(value) {
  if (typeof value !== 'string' || value.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.includes('..') || value.includes('//') ||
      value.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))) {
    throw new Error('invalid branch name; supply a plain branch, not a ref or revision expression');
  }
  if (value.startsWith('refs/')) throw new Error('supply a plain branch name');
  return value;
}

export function integrationPolicy(cfg, project) {
  const p = cfg.projects?.[project]?.integration;
  if (!p?.enabled) throw new Error(`integration is not enabled for ${project}; configure its exact origin, testing branches and container checks`);
  const url = new URL(p.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) {
    throw new Error('integration origin must be a credential-free HTTPS repository URL');
  }
  const remote = parseRemote(p.origin);
  const host = remote && hostConfigFor(cfg, remote.host);
  if (!host || host.type !== 'github' || !/^[\w.-]+$/.test(remote.owner) || !/^[\w.-]+$/.test(remote.repo)) {
    throw new Error('integration publication currently supports configured GitHub hosts only');
  }
  const targets = p.testing_branches;
  if (!Array.isArray(targets) || !targets.length || targets.length > 50) throw new Error('configure explicit testing_branches');
  for (const target of targets) {
    branchName(target);
    if (!target.startsWith('testing/') || target.startsWith('testing/integration/')) throw new Error('testing base must be under testing/ outside testing/integration/');
  }
  if (!Array.isArray(p.checks) || !p.checks.length || p.checks.length > 8) throw new Error('configure 1–8 container validation checks');
  for (const c of p.checks) {
    if (!/^[\w.-]{1,60}$/.test(c.name) ||
        !/^(?:[A-Za-z0-9][A-Za-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(c.image) ||
        (c.memory_mb !== undefined && (!Number.isInteger(c.memory_mb) || c.memory_mb < 512 || c.memory_mb > 8192)) ||
        !Array.isArray(c.command) || !c.command.length || c.command.length > 32 ||
        c.command.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0')) ||
        !Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1 || c.timeout_seconds > 600) {
      throw new Error('checks require a name, digest-pinned image (registry digest or local sha256 ID), optional memory_mb (512–8192), argument array and timeout_seconds (1–600)');
    }
  }
  if (new Set(p.checks.map(c => c.name)).size !== p.checks.length) throw new Error('check names must be unique');
  return { ...p, remote, host };
}

export function policyHash(p) {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

export function verifySelection(policy, base, sources, defaultBranch, candidate) {
  branchName(base);
  if (!policy.testing_branches.includes(base)) throw new Error('testing base is not allowlisted');
  const protectedNames = new Set(['main', 'master', defaultBranch, ...(policy.protected_branches || [])]);
  if (protectedNames.has(base) || (candidate && protectedNames.has(candidate))) throw new Error('protected branch destination refused');
  if (candidate && (!branchName(candidate).startsWith('testing/integration/') || candidate === base)) throw new Error('invalid integration destination');
  if (!Array.isArray(sources) || !sources.length || sources.length > 8 || new Set(sources).size !== sources.length) {
    throw new Error('supply 1–8 unique source branches in merge order');
  }
  for (const source of sources) {
    branchName(source);
    const baseline = source === defaultBranch && policy.allow_default_baseline === true;
    if (!baseline && !source.startsWith('bridge/')) throw new Error('sources must be bridge branches or the explicitly enabled default baseline');
    if (source === base) throw new Error('base cannot also be a source');
  }
}

export function sourceProvenance(jobs, policy, project, branch, sha, defaultBranch) {
  if (branch === defaultBranch && policy.allow_default_baseline === true) return { kind: 'default_baseline' };
  const job = [...jobs.values()].find(j => j.project === project && j.branch === branch && j.pushed === true && j.pushed_sha === sha);
  if (job) return { kind: 'bridge_job', job_id: job.id };
  // Legacy jobs did not record pushed tips. An operator may pin a reviewed tip.
  if (policy.source_pins?.[branch] === sha) return { kind: 'operator_pin' };
  throw new Error(`source ${branch} has no bridge publication record for ${sha}; legacy sources need an operator-reviewed source_pins entry`);
}

export async function repositoryMetadata(policy) {
  const { owner, repo } = policy.remote;
  const response = await apiFetch(policy.host, `/repos/${owner}/${repo}`);
  if (!response.ok || !response.json?.default_branch) throw new Error('cannot verify repository default branch');
  return response.json;
}

export async function authentication(policy) {
  const credential = await credentialFor(policy.remote.host);
  if (!credential) throw new Error('no stored GitHub credentials for integration origin');
  const basic = Buffer.from(`${credential.username || 'x-access-token'}:${credential.password}`).toString('base64');
  addSecret(basic);
  return {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${policy.origin}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export async function openIntegrationPr(policy, record) {
  const { owner, repo } = policy.remote;
  const body = [
    `Integrates the following pinned sources into \`${record.base}\` for review.`, '',
    `Base: \`${record.base_sha}\``,
    ...record.sources.map(s => `- \`${s.branch}\`: \`${s.sha}\``), '',
    `Candidate: \`${record.candidate_sha}\``,
    `Integration record: \`${record.id}\`. Existing branches were not updated.`, '',
    'Validation:', ...record.validation.candidate.map(c => `- ${c.name}: exit ${c.exit_code}`),
    '', 'Baseline:', ...record.validation.baseline.map(c => `- ${c.name}: exit ${c.exit_code}`),
  ].join('\n');
  // On retry/recovery reuse the existing PR instead of posting another one.
  const existing = await apiFetch(policy.host, `/repos/${owner}/${repo}/pulls`, {
    searchParams: { head: `${owner}:${record.candidate}`, base: record.base, state: 'open', per_page: 2 },
  });
  if (!existing.ok) throw new Error('cannot check for an existing integration PR');
  if (existing.json?.length) return existing.json[0].html_url;
  const response = await apiFetch(policy.host, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST', body: { title: `Integrate into ${record.base}`, head: record.candidate, base: record.base, body, draft: true },
  });
  if (!response.ok || !response.json?.html_url) throw new Error(`draft PR creation failed (${response.status}); candidate branch is preserved`);
  return response.json.html_url;
}
