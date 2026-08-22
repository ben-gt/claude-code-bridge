// Docker Compose control for projects under the workspace root.
// Hard rules: no `down`, nothing that removes volumes or prunes — those verbs don't exist here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveProjectDir, BoundaryError, isInside } from './paths.js';
import { run } from './git.js';
import { scrub } from './scrub.js';

export const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:[.-][A-Za-z0-9_-]+)*\.ya?ml$/;
const CANONICAL = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next']);

/** Every compose file in a project (root + two levels down), relative paths, canonical flagged. */
export function findComposeFiles(projectDir, maxDepth = 2) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && COMPOSE_FILE_RE.test(e.name)) {
        const rel = path.relative(projectDir, path.join(dir, e.name));
        out.push({ file: rel, dir: path.dirname(rel) === '.' ? '' : path.dirname(rel), canonical: depth === 0 && CANONICAL.includes(e.name), override: /\.override\.ya?ml$/.test(e.name) });
      } else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(projectDir, 0);
  return out.sort((a, b) => (b.canonical - a.canonical) || a.file.localeCompare(b.file));
}

const ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', DOCKER_CLI_HINTS: 'false', COMPOSE_ANSI: 'never' });

/**
 * Resolve which compose file(s) to use and verify boundaries + protection.
 * Default: the single canonical file (plus its .override companion, which compose applies itself)
 * when that's all there is; otherwise `file` is required and must be one of the detected files.
 */
export function resolveComposeTarget(cfg, projectName, { file, profile } = {}) {
  const dir = resolveProjectDir(cfg, projectName);
  const name = path.relative(fs.realpathSync(cfg.workspace_root), dir);
  const files = findComposeFiles(dir);
  if (!files.length) throw new BoundaryError(`${name} has no Compose file`);
  let chosen;
  let cwd = dir;
  const args = [];
  if (file) {
    const rel = path.normalize(String(file));
    const hit = files.find(f => f.file === rel || f.file === rel.replace(/^\.\//, ''));
    if (!hit) throw new BoundaryError(`file "${file}" is not one of the Compose files in ${name}: ${files.map(f => f.file).join(', ')}`);
    const real = fs.realpathSync(path.join(dir, hit.file));
    if (!isInside(dir, real)) throw new BoundaryError(`refused: ${file} resolves outside ${name}`);
    chosen = [hit.file];
    cwd = path.dirname(real);
    args.push('-f', real);
  } else {
    const canon = files.filter(f => f.canonical);
    const others = files.filter(f => !f.canonical && !(f.override && !f.dir));
    if (canon.length === 1 && others.length === 0) {
      chosen = files.filter(f => !f.dir).map(f => f.file); // canonical (+override), compose picks them up from cwd
    } else {
      throw new BoundaryError(`${name} has ${files.length} Compose files; pass file= to choose one of: ${files.map(f => f.file).join(', ')}`);
    }
  }
  if (profile) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) throw new BoundaryError('invalid profile name');
    args.push('--profile', profile);
  }
  const protectedBy = isProtected(cfg, name);
  return { project: name, dir, cwd, files: chosen, allFiles: files, args, protectedBy };
}

// ---- protection ----------------------------------------------------------
let selfProject = null; // compose project of the bridge's own container, if it runs in docker
export async function detectSelfComposeProject() {
  try {
    if (!fs.existsSync('/.dockerenv') && !/docker|containerd/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'))) return null;
    const host = (process.env.HOSTNAME || fs.readFileSync('/etc/hostname', 'utf8')).trim();
    const r = await run('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', host], { timeoutMs: 10_000, env: ENV() });
    if (r.code === 0 && r.stdout.trim()) selfProject = r.stdout.trim();
  } catch { /* not in docker */ }
  return selfProject;
}

export function protectedList(cfg) {
  const list = new Set(cfg.compose?.protected || []);
  if (selfProject) list.add(selfProject);
  return [...list];
}

/** Returns the reason string if `name` (dir name or compose project name) is protected, else null. */
export function isProtected(cfg, name, composeProjectName) {
  const list = protectedList(cfg);
  if (list.includes(name)) return `"${name}" is on the protected list (compose.protected in config.json)`;
  if (composeProjectName && list.includes(composeProjectName)) return `compose project "${composeProjectName}" is on the protected list`;
  if (selfProject && composeProjectName === selfProject) return `compose project "${composeProjectName}" runs this bridge`;
  return null;
}

// ---- running compose -----------------------------------------------------
export function composeBase(target) {
  return ['compose', '--ansi', 'never', ...target.args];
}

export async function compose(target, subArgs, { timeoutMs = 60_000, scrubOutput = true } = {}) {
  return run('docker', [...composeBase(target), ...subArgs], { cwd: target.cwd, timeoutMs, env: ENV(), scrubOutput });
}

/** Compose project name + services (with build flags) from `config`. */
export async function composeConfig(target) {
  // Unscrubbed on purpose: parsed internally, only names/build flags leave this function.
  const r = await compose(target, ['config', '--format', 'json'], { timeoutMs: 60_000, scrubOutput: false });
  if (r.code !== 0) throw new Error(`docker compose config failed: ${scrub(trimErr(r))}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new Error('could not parse docker compose config output'); }
  const services = Object.entries(j.services || {}).map(([k, v]) => ({ name: k, image: v.image || null, build: !!v.build }));
  return { name: j.name || path.basename(target.dir), services };
}

export async function composeStatus(target, services = []) {
  const r = await compose(target, ['ps', '-a', '--format', 'json', ...services], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`docker compose ps failed: ${trimErr(r)}`);
  return parsePs(r.stdout);
}

export function parsePs(text) {
  const t = text.trim();
  if (!t) return [];
  let items = [];
  try {
    const j = JSON.parse(t);
    items = Array.isArray(j) ? j : [j];
  } catch {
    for (const line of t.split('\n')) { try { items.push(JSON.parse(line)); } catch { /* skip */ } }
  }
  return items.map(c => ({
    service: c.Service, container: c.Name, image: c.Image, state: c.State, health: c.Health || undefined, status: c.Status,
    exit_code: c.ExitCode, ports: uniq((c.Publishers || []).filter(p => p.PublishedPort).map(p => `${p.URL}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`)),
  })).sort((a, b) => String(a.service).localeCompare(String(b.service)));
}

export async function composeLogs(target, { services = [], lines = 200, since } = {}) {
  const args = ['logs', '--no-color', '--timestamps', '--tail', String(Math.min(Math.max(1, lines), 5000))];
  if (since) {
    if (!/^[0-9]+[smhd]?$|^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(since)) throw new BoundaryError('since must look like 10m, 2h, 1d or an ISO timestamp');
    args.push('--since', since);
  }
  args.push(...services);
  const r = await compose(target, args, { timeoutMs: 45_000 });
  if (r.code !== 0) throw new Error(`docker compose logs failed: ${trimErr(r)}`);
  let text = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
  const cap = 200_000;
  if (text.length > cap) text = `…(truncated ${text.length - cap} chars)…\n` + text.slice(-cap);
  return scrub(text);
}

export function validateServices(services) {
  if (services === undefined || services === null) return [];
  const list = Array.isArray(services) ? services : String(services).split(',').map(s => s.trim()).filter(Boolean);
  for (const s of list) if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) throw new BoundaryError(`invalid service name "${s}"`);
  return list;
}

/**
 * Spawn a compose subcommand and stream its (scrubbed) output lines to onLine.
 * Returns {code, timedOut}. Used by redeploy jobs so progress is visible while pulling/building.
 */
export function composeStream(target, subArgs, { onLine, timeoutMs, signalHolder }) {
  return new Promise(resolve => {
    const child = spawn('docker', [...composeBase(target), ...subArgs], { cwd: target.cwd, env: ENV(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (signalHolder) signalHolder.child = child;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutMs);
    const feed = (stream, tag) => {
      let buf = '';
      stream.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r/g, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(`${tag}${scrub(l)}`); }
      });
      stream.on('end', () => { if (buf.trim()) onLine(`${tag}${scrub(buf.replace(/\r/g, ''))}`); });
    };
    feed(child.stdout, '');
    feed(child.stderr, '');
    child.on('error', e => onLine(`spawn error: ${e.message}`));
    child.on('close', code => { clearTimeout(timer); if (signalHolder) signalHolder.child = null; resolve({ code, timedOut }); });
  });
}

export function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }, 8000).unref();
}

export async function dockerAvailable() {
  const r = await run('docker', ['compose', 'version', '--short'], { timeoutMs: 10_000, env: ENV() }).catch(e => ({ code: 1, stderr: e.message, stdout: '' }));
  return r.code === 0 ? r.stdout.trim() : null;
}

function trimErr(r) { return (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | '); }
function uniq(a) { return [...new Set(a)]; }
