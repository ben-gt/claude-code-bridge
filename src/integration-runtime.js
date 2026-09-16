// Controller-owned processes. Repository code runs only inside a disposable container.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './scrub.js';

export const gitEnvironment = {
  PATH: process.env.PATH, HOME: '/nonexistent', LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat',
};

export function boundedRun(command, args, { cwd, env = {}, signal, input, timeoutMs = 120_000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('integration cancelled'));
    const child = spawn(command, args, { cwd, env: { ...gitEnvironment, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const stop = reason => {
      failure ||= new Error(reason);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const abort = () => stop('integration cancelled');
    const timer = setTimeout(() => stop('integration command timed out'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = target => chunk => {
      size += chunk.length;
      if (size > maxBytes) return stop('integration command output exceeded limit');
      if (target === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure); else resolve({ code, stdout: scrub(stdout), stderr: scrub(stderr) });
    });
    child.stdin.on('error', () => {}); // an early-exiting child may close stdin
    child.stdin.end(input);
  });
}

export async function integrationGit(dir, args, options = {}) {
  const r = await boundedRun('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
    '-c', 'http.followRedirects=false', ...args,
  ], { ...options, cwd: dir });
  if (r.code !== 0 && !options.allowFailure) throw new Error(`git ${args[0]} failed: ${r.stderr.slice(0, 2000)}`);
  return r;
}

export function validationArgs(name, check) {
  return ['run', '--rm', '-i', '--name', name, '--pull=never', '--network=none',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    '--pids-limit=256', `--memory=${check.memory_mb || 2048}m`, '--cpus=2', '--ulimit', 'nofile=1024:1024',
    '--tmpfs', '/workspace:rw,exec,mode=1777,size=2147483648',
    '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777,size=268435456',
    '--env', 'HOME=/tmp', '--entrypoint', '/bin/sh', check.image,
    '-c', 'tar -xf - -C /workspace && cd /workspace && exec "$@"', 'bridge-check', ...check.command];
}

export async function validateSnapshot(dir, sha, checks, { id, phase, signal, save, run = boundedRun } = {}) {
  const archive = path.join(dir, `${phase}.tar`);
  await integrationGit(dir, ['archive', '--format=tar', `--output=${archive}`, sha], { signal });
  if (fs.statSync(archive).size > 128 * 1024 * 1024) throw new Error('validation snapshot exceeds 128 MiB');
  const input = fs.readFileSync(archive);
  fs.unlinkSync(archive);
  const results = [];
  for (const [index, check] of checks.entries()) {
    const name = `bridge-integration-${id}-${phase}-${index}`;
    try {
      const r = await run('docker', validationArgs(name, check), { input, signal, timeoutMs: check.timeout_seconds * 1000 });
      // 125 means Docker failed to launch; 126/127 are unavailable executables.
      if ([125, 126, 127].includes(r.code)) throw new Error(`validation runner unavailable: ${r.stderr || r.stdout}`);
      results.push({ name: check.name, exit_code: r.code, stdout: r.stdout, stderr: r.stderr });
      save?.(results);
    } finally {
      // Killing the Docker client does not reliably stop the container.
      await run('docker', ['rm', '-f', name], { timeoutMs: 15_000 }).catch(() => {});
    }
  }
  return results;
}
