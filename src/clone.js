// clone_project and list_available_repos.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cloneDestination, BoundaryError, realWorkspaceRoot } from './paths.js';
import { run, git } from './git.js';
import { scrub, scrubUrl } from './scrub.js';
import { apiFetch, hostConfigFor } from './credentials.js';

const HTTPS_RE = /^https:\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+?)\/?$/;
const SSH_URL_RE = /^ssh:\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+?)\/?$/;
const SCP_RE = /^([A-Za-z0-9_.-]+@)?([A-Za-z0-9_.-]+):([^\/].*)$/;

/**
 * Normalise and validate a clone source. Accepts:
 *   https://host/owner/repo(.git)   ssh://git@host/owner/repo   git@host:owner/repo.git   owner/repo (+host)
 * Rejects every other scheme (file://, http://, git://, ext::, local paths).
 * Userinfo is stripped from https URLs — auth comes from the credential helper.
 */
export function normaliseSource(cfg, { url, repo, host }) {
  if (url && repo) throw new BoundaryError('pass either url or repo, not both');
  if (!url && !repo) throw new BoundaryError('url or repo is required');
  if (repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) throw new BoundaryError(`repo must look like owner/repo, got "${repo}"`);
    const h = host || cfg.clone.hosts?.[0]?.host;
    if (!h) throw new BoundaryError('no host given and no default host configured');
    const hc = hostConfigFor(cfg, h);
    if (!hc) throw new BoundaryError(`host ${h} is not in clone.hosts config`);
    return { cloneUrl: `https://${h}/${repo}.git`, host: h, pathPart: repo, scheme: 'https', suggestedName: repo.split('/')[1] };
  }
  const u = String(url).trim();
  if (u.includes('\0') || /\s/.test(u)) throw new BoundaryError('malformed url');
  let m;
  if ((m = u.match(HTTPS_RE))) {
    const pathPart = m[2].replace(/\.git$/, '');
    return { cloneUrl: `https://${m[1]}/${pathPart}.git`.replace(/\.git\.git$/, '.git'), host: m[1], pathPart, scheme: 'https', suggestedName: pathPart.split('/').pop() };
  }
  if ((m = u.match(SSH_URL_RE))) {
    const pathPart = m[2].replace(/\.git$/, '');
    return { cloneUrl: u, host: m[1], pathPart, scheme: 'ssh', suggestedName: pathPart.split('/').pop() };
  }
  if (!u.includes('://') && (m = u.match(SCP_RE))) {
    const pathPart = m[3].replace(/\.git$/, '');
    return { cloneUrl: u, host: m[2], pathPart, scheme: 'ssh', suggestedName: pathPart.split('/').pop() };
  }
  throw new BoundaryError(`refused: unsupported clone source "${scrubUrl(u)}" (only https://, ssh:// and git@host:path are allowed)`);
}

async function dirSizeMb(dir) {
  const r = await run('du', ['-sm', dir], { timeoutMs: 120_000 });
  if (r.code !== 0) return null;
  return Number(r.stdout.split(/\s/)[0]) || 0;
}

/**
 * Clone into the workspace. Never overwrites: if the destination exists, returns it untouched.
 * Clones into a hidden temp dir under the workspace root and renames into place on success,
 * so an interrupted clone never leaves a half-populated <name> directory.
 */
export async function cloneProject(cfg, { url, repo, host, name, branch, depth, full_history }, { onProgress } = {}) {
  const src = normaliseSource(cfg, { url, repo, host });
  const { root, name: clean, dest } = cloneDestination(cfg, name || src.suggestedName);
  if (fs.existsSync(dest)) {
    return { status: 'exists', name: clean, path: dest, message: `${clean} is already present at ${dest}; working tree untouched` };
  }
  if (branch && !/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || (branch && (branch.startsWith('-') || branch.includes('..')))) {
    throw new BoundaryError('invalid branch name');
  }
  const effDepth = full_history ? 0 : (depth ?? cfg.clone.depth ?? 1);
  const tmpParent = path.join(root, '.bridge-tmp');
  fs.mkdirSync(tmpParent, { recursive: true });
  const tmp = path.join(tmpParent, `${clean}-${randomBytes(4).toString('hex')}`);
  const args = ['clone', '--no-hardlinks', '--progress'];
  if (effDepth > 0) args.push('--depth', String(effDepth), '--no-single-branch');
  if (branch) args.push('--branch', branch);
  args.push('--', src.cloneUrl, tmp);
  const timeoutMs = (cfg.clone.timeout_seconds ?? 600) * 1000;
  const started = Date.now();
  let r;
  try {
    r = await run('git', args, { timeoutMs });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`clone failed: ${scrub(e.message)}`);
  }
  if (r.code !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`clone failed (exit ${r.code}): ${scrub(why)}`);
  }
  const sizeMb = await dirSizeMb(tmp);
  const cap = cfg.clone.max_size_mb ?? 2048;
  if (sizeMb !== null && sizeMb > cap) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`clone aborted: ${sizeMb} MB exceeds clone.max_size_mb (${cap} MB); partial clone removed`);
  }
  if (fs.existsSync(dest)) { // raced with something else
    fs.rmSync(tmp, { recursive: true, force: true });
    return { status: 'exists', name: clean, path: dest, message: `${clean} appeared during the clone; kept the existing directory` };
  }
  fs.renameSync(tmp, dest);
  try { fs.rmdirSync(tmpParent); } catch { /* not empty or gone */ }
  let headBranch = null;
  try { headBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dest })).trim(); } catch { /* ignore */ }
  return {
    status: 'cloned',
    name: clean,
    path: dest,
    branch: headBranch,
    shallow: effDepth > 0 ? effDepth : false,
    size_mb: sizeMb,
    seconds: Math.round((Date.now() - started) / 1000),
    source: scrubUrl(src.cloneUrl),
  };
}

/** Remove leftover temp clone dirs (e.g. after a crash). */
export function cleanCloneTemp(cfg) {
  try {
    const tmpParent = path.join(realWorkspaceRoot(cfg), '.bridge-tmp');
    if (fs.existsSync(tmpParent)) fs.rmSync(tmpParent, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Repos visible to the stored credential on each configured host. */
export async function listAvailableRepos(cfg, { host, query, limit = 100 } = {}) {
  const hosts = (cfg.clone.hosts || []).filter(h => !host || h.host === host);
  if (!hosts.length) return { hosts: [], repos: [], note: host ? `host ${host} not configured` : 'no hosts configured' };
  const root = realWorkspaceRoot(cfg);
  const localNames = new Set((() => { try { return fs.readdirSync(root); } catch { return []; } })());
  const repos = [];
  const hostResults = [];
  for (const hc of hosts) {
    try {
      const list = await fetchRepoList(hc, limit);
      hostResults.push({ host: hc.host, type: hc.type, ok: true, count: list.length });
      for (const r of list) {
        if (query && !`${r.full_name} ${r.description || ''}`.toLowerCase().includes(query.toLowerCase())) continue;
        repos.push({ ...r, host: hc.host, already_cloned: localNames.has(r.name) ? path.join(root, r.name) : false });
      }
    } catch (e) {
      hostResults.push({ host: hc.host, type: hc.type, ok: false, error: scrub(e.message) });
    }
  }
  repos.sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
  return { hosts: hostResults, repos: repos.slice(0, limit) };
}

async function fetchRepoList(hc, limit) {
  const out = [];
  const perPage = 100;
  for (let page = 1; out.length < limit && page <= 10; page++) {
    let res;
    if (hc.type === 'github') {
      res = await apiFetch(hc, '/user/repos', { searchParams: { per_page: perPage, page, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' } });
    } else if (hc.type === 'gitea') {
      res = await apiFetch(hc, '/user/repos', { searchParams: { limit: 50, page } });
    } else if (hc.type === 'gitlab') {
      res = await apiFetch(hc, '/projects', { searchParams: { membership: true, per_page: perPage, page, order_by: 'last_activity_at' } });
    } else {
      throw new Error(`unsupported host type ${hc.type}`);
    }
    if (!res.ok) throw new Error(`${hc.host} API ${res.status}: ${scrub((res.json?.message) || res.text.slice(0, 200))}`);
    const items = Array.isArray(res.json) ? res.json : [];
    if (!items.length) break;
    for (const it of items) {
      out.push(hc.type === 'gitlab' ? {
        name: it.path, full_name: it.path_with_namespace, private: it.visibility !== 'public',
        default_branch: it.default_branch, clone_url: it.http_url_to_repo, description: it.description, pushed_at: it.last_activity_at,
      } : {
        name: it.name, full_name: it.full_name, private: !!it.private,
        default_branch: it.default_branch, clone_url: scrubUrl(it.clone_url), description: it.description, pushed_at: it.pushed_at || it.updated_at,
      });
    }
    if (items.length < (hc.type === 'gitea' ? 50 : perPage)) break;
  }
  return out;
}
