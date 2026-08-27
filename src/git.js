// Thin git helpers. Every call runs with a timeout and a credential-safe environment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './scrub.js';

export const GIT_ENV_BASE = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
  // Never page, never edit interactively.
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
};

export class GitError extends Error {
  constructor(msg, { code, stderr } = {}) {
    super(msg);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

/** Run a command, capture output, enforce a timeout. stdout/stderr are scrubbed. */
export function run(cmd, args, { cwd, timeoutMs = 30_000, env = {}, input, scrubOutput = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...GIT_ENV_BASE, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new GitError(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`, { code: 'TIMEOUT' }));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      if (done) return;
      done = true; clearTimeout(timer); reject(e);
    });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, stdout: scrubOutput ? scrub(out) : out, stderr: scrubOutput ? scrub(err) : err });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export async function git(args, opts = {}) {
  const r = await run('git', args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, { code: r.code, stderr: r.stderr });
  }
  return r.stdout;
}

/** Resolve the .git directory for a repo dir (handles `.git` files used by worktrees/submodules). */
export function gitDirOf(dir) {
  const dotgit = path.join(dir, '.git');
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    if (st.isFile()) {
      const content = fs.readFileSync(dotgit, 'utf8').trim();
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m) return path.resolve(dir, m[1]);
    }
  } catch { /* not a repo */ }
  return null;
}

export function isGitRepo(dir) {
  return gitDirOf(dir) !== null;
}

/** Current branch name, or null when detached. Fast path via .git/HEAD. */
export function currentBranchFast(dir) {
  const gd = gitDirOf(dir);
  if (!gd) return null;
  try {
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** origin URL from .git/config (scrubbed), or null. */
export function remoteUrlFast(dir) {
  const gd = gitDirOf(dir);
  if (!gd) return null;
  try {
    // For worktrees, config lives in the common dir.
    let cfgPath = path.join(gd, 'config');
    if (!fs.existsSync(cfgPath)) {
      const common = path.join(gd, 'commondir');
      if (fs.existsSync(common)) cfgPath = path.join(path.resolve(gd, fs.readFileSync(common, 'utf8').trim()), 'config');
    }
    const text = fs.readFileSync(cfgPath, 'utf8');
    const sect = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    if (!sect) {
      const any = text.match(/\[remote "[^"]+"\]([\s\S]*?)(?=\n\[|$)/);
      if (!any) return null;
      const u = any[1].match(/^\s*url\s*=\s*(.+)$/m);
      return u ? scrub(u[1].trim()) : null;
    }
    const u = sect[1].match(/^\s*url\s*=\s*(.+)$/m);
    return u ? scrub(u[1].trim()) : null;
  } catch { return null; }
}

/**
 * Default branch inference:
 *   1. explicit override
 *   2. refs/remotes/origin/HEAD
 *   3. a local 'main' or 'master' branch
 *   4. current branch
 */
export async function defaultBranch(dir, override) {
  if (override) return override;
  try {
    const ref = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: dir })).trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* no origin HEAD */ }
  for (const cand of ['main', 'master', 'develop']) {
    const r = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`], { cwd: dir });
    if (r.code === 0) return cand;
  }
  return currentBranchFast(dir);
}

/** Returns { dirty, entries[] } using porcelain status. */
export async function workingTreeStatus(dir, { includeUntracked = true, timeoutMs = 60_000 } = {}) {
  const args = ['status', '--porcelain', includeUntracked ? '--untracked-files=normal' : '--untracked-files=no'];
  const out = await git(args, { cwd: dir, timeoutMs });
  const entries = out.split('\n').filter(Boolean);
  return { dirty: entries.length > 0, entries };
}

export async function hasRemote(dir, name = 'origin') {
  const r = await run('git', ['remote', 'get-url', name], { cwd: dir });
  return r.code === 0;
}

export async function revParse(dir, ref) {
  return (await git(['rev-parse', '--verify', '--quiet', ref], { cwd: dir })).trim();
}

export async function branchExists(dir, branch) {
  const r = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir });
  return r.code === 0;
}

/** Create a worktree. { branch, startPoint } makes a new branch; { detach, ref } gives a read-only snapshot. */
export async function worktreeAdd(repoDir, wtPath, { branch, startPoint, detach, ref } = {}) {
  const args = ['worktree', 'add', '--quiet'];
  if (branch) args.push('-b', branch, wtPath, startPoint);
  else args.push('--detach', wtPath, ref || 'HEAD');
  await git(args, { cwd: repoDir, timeoutMs: 120_000 });
}

/** Remove a worktree registration and its directory (best-effort, idempotent). */
export async function worktreeDiscard(repoDir, wtPath) {
  const r = await run('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoDir, timeoutMs: 60_000 }).catch(() => ({ code: -1 }));
  if (r.code !== 0) {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
    await run('git', ['worktree', 'prune'], { cwd: repoDir }).catch(() => {});
  }
}

/** Parse host/owner/repo out of an https or ssh remote URL. */
export function parseRemote(url) {
  if (!url) return null;
  let m = url.match(/^(?:https?|ssh):\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (m) {
    const [owner, ...rest] = m[2].split('/');
    return { host: m[1], owner, repo: rest.join('/') };
  }
  m = url.match(/^(?:[^@]+@)?([^:\/]+):(.+?)(?:\.git)?\/?$/); // scp-like git@host:owner/repo
  if (m) {
    const [owner, ...rest] = m[2].split('/');
    return { host: m[1], owner, repo: rest.join('/') };
  }
  return null;
}
