// Integration is a deterministic controller operation, never an unrestricted agent job.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectDir } from './paths.js';
import { scrubDeep, scrub } from './scrub.js';
import { integrationGit, validateSnapshot, boundedRun } from './integration-runtime.js';
import { integrationPolicy, policyHash, verifySelection, sourceProvenance, repositoryMetadata, authentication, openIntegrationPr } from './integration-policy.js';

const ACTIVE = new Set(['planning', 'validating', 'publishing', 'cancelling']);
const MAX_AGE = 24 * 60 * 60 * 1000;

export class IntegrationManager {
  constructor(cfg, jobs, dependencies = {}) {
    this.cfg = cfg;
    this.jobs = jobs;
    this.root = path.join(cfg.data_dir, 'integrations');
    this.records = new Map();
    this.active = new Map();
    this.locks = new Set();
    this.git = dependencies.git || integrationGit;
    this.validate = dependencies.validate || validateSnapshot;
    this.metadata = dependencies.metadata || repositoryMetadata;
    this.auth = dependencies.auth || authentication;
    this.openPr = dependencies.openPr || openIntegrationPr;
    this.run = dependencies.run || boundedRun;
  }

  async init() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(this.root).filter(n => /^i_[a-f0-9-]{36}\.json$/.test(n))) {
      const record = JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8'));
      if (`${record.id}.json` !== file) throw new Error('invalid integration record');
      this.records.set(record.id, record);
      if (ACTIVE.has(record.state)) {
        record.state = 'interrupted';
        record.error = 'bridge restarted; candidate retained, publication must be reconciled before retry';
        this.save(record);
        // Validation containers have no host mounts; remove any left by a killed client.
        for (const phase of ['baseline', 'candidate']) {
          for (let index = 0; index < (record.checks?.length || 0); index++) {
            await this.run('docker', ['rm', '-f', `bridge-integration-${record.id}-${phase}-${index}`], { timeoutMs: 15_000 }).catch(() => {});
          }
        }
      }
    }
  }

  save(record) {
    record.updated_at = new Date().toISOString();
    const file = path.join(this.root, `${record.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(scrubDeep(record), null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error('integration record not found');
    return structuredClone(record);
  }

  list() {
    return [...this.records.values()].slice(-100).map(({ id, project, base, candidate, state, updated_at, pr_url }) =>
      ({ id, project, base, candidate, state, updated_at, pr_url }));
  }

  directory(record) { return path.join(this.root, record.id); }
  runningCount() { return this.active.size; }

  launch(record, state, operation) {
    const lock = `${record.project}:${record.base}`;
    if (this.locks.has(lock)) throw new Error('another integration is active for this testing branch');
    const concurrency = this.cfg.integrations?.max_concurrent === 1 ? 1 : 2;
    if (this.active.size >= concurrency) throw new Error('integration concurrency limit reached; retry when an integration finishes');
    const controller = new AbortController();
    this.locks.add(lock);
    record.state = state;
    delete record.error;
    this.save(record);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const task = Promise.resolve().then(() => operation(controller.signal)).catch(e => {
      record.state = controller.signal.aborted ? 'cancelled' : 'failed';
      record.error = scrub(e.message);
    }).finally(() => {
      clearTimeout(timer);
      this.save(record);
      this.active.delete(record.id);
      this.locks.delete(lock);
    });
    this.active.set(record.id, { controller, task });
    return this.get(record.id);
  }

  plan({ project, base_branch, sources }) {
    // Canonical directory names prevent aliasing the same repository under different policies/locks.
    const dir = resolveProjectDir(this.cfg, project);
    if (path.basename(dir) !== project) throw new Error('use the canonical project directory name');
    const policy = integrationPolicy(this.cfg, project);
    verifySelection(policy, base_branch, sources, policy.allow_default_baseline ? sources.find(s => !s.startsWith('bridge/')) : null);
    if (this.records.size >= 1000) throw new Error('integration record limit reached; archive old records before creating more');
    const id = `i_${randomUUID()}`;
    const record = { id, project, base: base_branch, requested_sources: sources,
      candidate: `testing/integration/${id}`, created_at: new Date().toISOString(),
      origin: policy.origin, policy_hash: policyHash(policy), checks: policy.checks, state: 'new' };
    this.records.set(id, record);
    try { return this.launch(record, 'planning', signal => this.prepare(record, dir, policy, signal)); }
    catch (e) { this.records.delete(id); throw e; }
  }

  async prepare(record, projectDir, policy, signal) {
    const metadata = await this.metadata(policy);
    record.default_branch = metadata.default_branch;
    verifySelection(policy, record.base, record.requested_sources, record.default_branch, record.candidate);
    const origin = await this.git(projectDir, ['config', '--get', 'remote.origin.url'], { signal });
    if (origin.stdout.trim() !== policy.origin) throw new Error('project origin does not match the configured integration origin');
    const dir = this.directory(record);
    fs.mkdirSync(dir, { mode: 0o700 });
    await this.git(dir, ['init', '--quiet'], { signal });
    const env = await this.auth(policy);
    const branches = [record.base, ...record.requested_sources];
    await this.git(dir, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', policy.origin,
      ...branches.map((b, i) => `refs/heads/${b}:refs/bridge-inputs/${i}`)], { signal, env });
    const resolved = [];
    for (const [i, branch] of branches.entries()) {
      const r = await this.git(dir, ['rev-parse', '--verify', `refs/bridge-inputs/${i}^{commit}`], { signal });
      resolved.push({ branch, sha: r.stdout.trim() });
    }
    record.base_sha = resolved.shift().sha;
    record.sources = resolved.map(s => ({ ...s, provenance: sourceProvenance(this.jobs.jobs, policy, record.project, s.branch, s.sha, record.default_branch) }));
    await this.assertFresh(record, policy, signal);
    await this.git(dir, ['checkout', '--quiet', '-b', record.candidate, record.base_sha], { signal });
    record.steps = [];
    for (const source of record.sources) {
      const log = await this.git(dir, ['log', '--max-count=100', '--format=%h %s', `HEAD..${source.sha}`], { signal });
      const merge = await this.git(dir, ['merge', '--no-ff', '--no-commit', source.sha], { signal, allowFailure: true, env: this.author() });
      if (merge.code !== 0) {
        const conflicts = await this.git(dir, ['diff', '--name-only', '--diff-filter=U'], { signal });
        record.conflicts = conflicts.stdout.trim().split('\n').filter(Boolean);
        await this.git(dir, ['merge', '--abort'], { allowFailure: true });
        if (!record.conflicts.length) throw new Error(`merge failed: ${merge.stderr}`);
        record.state = 'conflicted';
        record.conflicting_source = source;
        this.save(record);
        return;
      }
      const merging = await this.git(dir, ['rev-parse', '--verify', 'MERGE_HEAD'], { signal, allowFailure: true });
      if (merging.code === 0) await this.git(dir, ['commit', '--quiet', '-m', `Integrate ${source.branch} (${source.sha})`], { signal, env: this.author() });
      record.steps.push({ source: source.branch, incoming_commits: log.stdout, commit_list_limit: 100 });
      this.save(record);
    }
    record.candidate_sha = (await this.git(dir, ['rev-parse', 'HEAD'], { signal })).stdout.trim();
    record.diff_stat = (await this.git(dir, ['diff', '--stat', record.base_sha, record.candidate_sha], { signal })).stdout;
    record.state = record.candidate_sha === record.base_sha ? 'no_changes' : 'planned';
    this.save(record);
  }

  author() {
    return { GIT_AUTHOR_NAME: 'Code Bridge', GIT_AUTHOR_EMAIL: 'code-bridge@localhost',
      GIT_COMMITTER_NAME: 'Code Bridge', GIT_COMMITTER_EMAIL: 'code-bridge@localhost' };
  }

  async assertFresh(record, policy, signal) {
    if (Date.now() - Date.parse(record.created_at) > MAX_AGE) throw new Error('integration plan expired; create a new plan');
    if (policyHash(policy) !== record.policy_hash) throw new Error('integration policy changed; create a new plan');
    const metadata = await this.metadata(policy);
    if (metadata.default_branch !== record.default_branch) throw new Error('default branch changed; create a new plan');
    verifySelection(policy, record.base, record.requested_sources, metadata.default_branch, record.candidate);
    const origin = await this.git(resolveProjectDir(this.cfg, record.project), ['config', '--get', 'remote.origin.url'], { signal });
    if (origin.stdout.trim() !== policy.origin) throw new Error('project origin changed');
    const env = await this.auth(policy);
    const inputs = [{ branch: record.base, sha: record.base_sha }, ...record.sources];
    const refs = await this.git(this.directory(record), ['ls-remote', '--refs', policy.origin,
      ...inputs.map(s => `refs/heads/${s.branch}`), `refs/heads/${record.candidate}`], { signal, env });
    const tips = new Map(refs.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [sha, ref] = line.split(/\s+/); return [ref, sha];
    }));
    for (const source of inputs) {
      if (tips.get(`refs/heads/${source.branch}`) !== source.sha) throw new Error(`branch moved or disappeared: ${source.branch}; create a new plan`);
    }
    for (const s of record.sources) sourceProvenance(this.jobs.jobs, policy, record.project, s.branch, s.sha, record.default_branch);
    return { env, candidateTip: tips.get(`refs/heads/${record.candidate}`) };
  }

  execute(id) {
    const record = this.records.get(id);
    if (!record || record.state !== 'planned') throw new Error('only a completed, conflict-free plan can be executed');
    return this.launch(record, 'validating', async signal => {
      const policy = integrationPolicy(this.cfg, record.project);
      const { candidateTip } = await this.assertFresh(record, policy, signal);
      if (candidateTip) throw new Error('candidate branch already exists remotely');
      record.validation = {};
      for (const phase of ['baseline', 'candidate']) {
        record.activity = `validating ${phase}`;
        record.validation[phase] = await this.validate(this.directory(record), record[`${phase === 'baseline' ? 'base' : 'candidate'}_sha`], policy.checks,
          { id: record.id, phase, signal, save: results => { record.validation[phase] = results; this.save(record); } });
      }
      record.validation.comparison = record.validation.candidate.map((c, index) => {
        const b = record.validation.baseline[index];
        return { name: c.name, outcome: c.exit_code === 0 ? (b.exit_code === 0 ? 'passing' : 'fixed') :
          (b.exit_code === c.exit_code && b.stdout === c.stdout && b.stderr === c.stderr ? 'unchanged_failure' : 'new_or_changed_failure') };
      });
      // Baseline failures are evidence, not permission to publish failing code.
      record.state = record.validation.candidate.every(c => c.exit_code === 0) ? 'validated' : 'validation_failed';
    });
  }

  publish(id) {
    const record = this.records.get(id);
    if (!record || !['validated', 'publication_failed', 'interrupted'].includes(record.state) ||
        !record.validation?.candidate?.length || record.validation.candidate.some(c => c.exit_code !== 0)) {
      throw new Error('publication requires a candidate with every configured validation check passing');
    }
    return this.launch(record, 'publishing', async signal => {
      try {
        const policy = integrationPolicy(this.cfg, record.project);
        const { env, candidateTip } = await this.assertFresh(record, policy, signal);
        if (candidateTip && candidateTip !== record.candidate_sha) throw new Error('candidate branch exists at an unexpected commit; refusing to update it');
        if (!candidateTip) {
          // Empty expected value is create-only CAS. Git cannot overwrite an existing
          // destination, even if somebody creates it between ls-remote and push.
          await this.git(this.directory(record), ['push', '--quiet',
            `--force-with-lease=refs/heads/${record.candidate}:`, policy.origin,
            `${record.candidate_sha}:refs/heads/${record.candidate}`], { signal, env });
        }
        record.pushed = true;
        this.save(record);
        if (signal.aborted) throw new Error('integration cancelled after push; candidate preserved');
        record.pr_url = await this.openPr(policy, record);
        record.state = 'published';
      } catch (e) {
        record.state = 'publication_failed';
        record.error = scrub(e.message);
      }
    });
  }

  cancel(id) {
    const record = this.records.get(id);
    if (!record) throw new Error('integration record not found');
    const active = this.active.get(id);
    if (active) { record.state = 'cancelling'; active.controller.abort(); }
    else if (['planned', 'validated'].includes(record.state)) record.state = 'cancelled';
    this.save(record);
    return this.get(id);
  }
}
