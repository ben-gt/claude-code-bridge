// Credential access goes through git's own credential helper (`git credential fill`).
// The bridge never reads ~/.git-credentials or any token file directly, never puts
// tokens in child environments, and registers every password it sees with the
// scrubber so it can't leak through a tool response or log.
import { run } from './git.js';
import { addSecret } from './scrub.js';

const cache = new Map(); // host -> {username,password,at}
const TTL_MS = 5 * 60 * 1000;

export async function credentialFor(host, protocol = 'https') {
  const key = `${protocol}://${host}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const input = `protocol=${protocol}\nhost=${host}\n\n`;
  const r = await run('git', ['credential', 'fill'], { input, timeoutMs: 10_000, env: { GIT_ASKPASS: '/bin/true' } });
  if (r.code !== 0) return null;
  const fields = {};
  // NOTE: run() scrubs output, but `git credential fill` output is key=value without
  // secret-looking keys except "password=" which the env rule redacts. Re-run raw for the value.
  const raw = await runRaw('git', ['credential', 'fill'], input);
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  if (!fields.password) return null;
  addSecret(fields.password);
  const cred = { username: fields.username || '', password: fields.password, at: Date.now() };
  cache.set(key, cred);
  return cred;
}

// Minimal unscrubbed runner used only for credential fill (value must be exact).
import { spawn } from 'node:child_process';
import { GIT_ENV_BASE } from './git.js';
function runRaw(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...GIT_ENV_BASE, GIT_ASKPASS: '/bin/true' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('credential fill timed out')); }, 10_000);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', () => { clearTimeout(t); resolve(out); });
    child.stdin.end(input);
  });
}

export function forgetCredentials() { cache.clear(); }

/** Authenticated JSON fetch against a host API, using the credential helper. */
export async function apiFetch(hostCfg, pathname, { method = 'GET', body, searchParams } = {}) {
  const cred = await credentialFor(hostCfg.host);
  if (!cred) throw new Error(`no stored credential for ${hostCfg.host} (git credential helper returned nothing)`);
  const base = hostCfg.api_base || defaultApiBase(hostCfg);
  const url = new URL(base.replace(/\/$/, '') + pathname);
  if (searchParams) for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json', 'User-Agent': 'claude-code-bridge' };
  if (hostCfg.type === 'github') {
    headers.Authorization = `Bearer ${cred.password}`;
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  } else if (hostCfg.type === 'gitea') {
    // Gitea accepts Basic with either a password or an access token; `token x` only works for tokens.
    headers.Authorization = cred.username
      ? `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`
      : `token ${cred.password}`;
  } else if (hostCfg.type === 'gitlab') {
    headers['PRIVATE-TOKEN'] = cred.password;
  } else {
    headers.Authorization = `Bearer ${cred.password}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

export function defaultApiBase(hostCfg) {
  switch (hostCfg.type) {
    case 'github': return hostCfg.host === 'github.com' ? 'https://api.github.com' : `https://${hostCfg.host}/api/v3`;
    case 'gitea': return `https://${hostCfg.host}/api/v1`;
    case 'gitlab': return `https://${hostCfg.host}/api/v4`;
    default: return `https://${hostCfg.host}`;
  }
}

export function hostConfigFor(cfg, host) {
  return (cfg.clone.hosts || []).find(h => h.host === host) || null;
}
