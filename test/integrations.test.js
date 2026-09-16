import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationManager } from '../src/integrations.js';
import { integrationGit, boundedRun, validateSnapshot } from '../src/integration-runtime.js';
import { integrationPolicy, verifySelection, branchName } from '../src/integration-policy.js';

const origin = 'https://github.com/example/project.git';
const image = `node@sha256:${'a'.repeat(64)}`;
const passing = [{ name: 'tests', exit_code: 0, stdout: 'passed', stderr: '' }];
const author = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const g = async (dir, args) => (await integrationGit(dir, args, { env: author })).stdout.trim();

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-integration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  await g(project, ['init', '-q', '-b', 'main']);
  await g(project, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(project, 'file.txt'), 'base\n');
  await g(project, ['add', '.']); await g(project, ['commit', '-qm', 'base']);
  const main = await g(project, ['rev-parse', 'HEAD']);
  await g(project, ['checkout', '-qb', 'testing/passkeys']);
  if (options.conflict) {
    fs.writeFileSync(path.join(project, 'file.txt'), 'testing\n');
    await g(project, ['commit', '-qam', 'testing change']);
  }
  const base = await g(project, ['rev-parse', 'HEAD']);
  await g(project, ['checkout', '-qb', 'bridge/feature-job', 'main']);
  fs.writeFileSync(path.join(project, options.conflict ? 'file.txt' : 'feature.txt'), 'feature\n');
  await g(project, ['add', '.']); await g(project, ['commit', '-qm', 'feature']);
  const source = await g(project, ['rev-parse', 'HEAD']);
  await g(project, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(project, 'untracked.txt'), 'leave me alone');
  const policy = { enabled: true, origin, testing_branches: ['testing/passkeys'], allow_default_baseline: true,
    checks: [{ name: 'tests', image, command: ['node', '--test'], timeout_seconds: 60 }] };
  const cfg = { workspace_root: root, data_dir: path.join(root, 'data'),
    clone: { hosts: [{ host: 'github.com', type: 'github' }] }, projects: { project: { integration: policy } } };
  const jobs = { jobs: new Map([['j_source', { id: 'j_source', project: 'project', branch: 'bridge/feature-job', pushed: true, pushed_sha: source }]]) };
  const calls = [];
  const git = async (dir, args, opts) => {
    calls.push([...args]);
    // Only tests substitute a local remote; production rejects file transport.
    if (['fetch', 'push', 'ls-remote'].includes(args[0])) {
      args = ['-c', 'protocol.file.allow=always', ...args.map(a => a === origin ? project : a)];
    }
    return integrationGit(dir, args, opts);
  };
  const dependencies = { git, metadata: async () => ({ default_branch: 'main' }), auth: async () => ({}),
    validate: async () => structuredClone(passing), openPr: async () => 'https://github.com/example/project/pull/1', ...options.dependencies };
  const m = new IntegrationManager(cfg, jobs, dependencies); await m.init();
  return { m, cfg, policy, jobs, root, project, main, base, source, calls, dependencies };
}

async function finish(m, id) {
  await m.active.get(id)?.task;
  return m.get(id);
}
async function plan(m) {
  const r = m.plan({ project: 'project', base_branch: 'testing/passkeys', sources: ['main', 'bridge/feature-job'] });
  return finish(m, r.id);
}

test('plans, validates and publishes without changing any existing ref or checkout', async t => {
  const { m, project, main, base, source, calls } = await fixture(t);
  const r = await plan(m);
  assert.equal(r.state, 'planned', r.error);
  assert.equal(r.base_sha, base);
  assert.equal(r.sources[1].provenance.job_id, 'j_source');
  assert.match(r.diff_stat, /feature.txt/);
  assert.equal(calls.filter(a => a[0] === 'push').length, 0);
  m.execute(r.id); const validated = await finish(m, r.id);
  assert.equal(validated.state, 'validated', validated.error);
  assert.equal(calls.filter(a => a[0] === 'push').length, 0);
  m.publish(r.id); const published = await finish(m, r.id);
  assert.equal(published.state, 'published', published.error);
  assert.match(published.pr_url, /pull\/1/);
  assert.equal(await g(project, ['rev-parse', r.candidate]), r.candidate_sha);
  assert.equal(await g(project, ['rev-parse', 'main']), main);
  assert.equal(await g(project, ['rev-parse', 'testing/passkeys']), base);
  assert.equal(await g(project, ['rev-parse', 'bridge/feature-job']), source);
  assert.equal(await g(project, ['branch', '--show-current']), 'main');
  assert.equal(fs.readFileSync(path.join(project, 'untracked.txt'), 'utf8'), 'leave me alone');
});

test('conflicts stop with paths and never reach validation or push', async t => {
  const { m, calls } = await fixture(t, { conflict: true });
  const r = await plan(m);
  assert.equal(r.state, 'conflicted', r.error);
  assert.deepEqual(r.conflicts, ['file.txt']);
  assert.throws(() => m.execute(r.id), /conflict-free/);
  assert.throws(() => m.publish(r.id), /validation/);
  assert.equal(calls.filter(a => a[0] === 'push').length, 0);
});

test('prefix alone cannot authorize a source; reviewed legacy pins can', async t => {
  const { m, jobs, policy, source } = await fixture(t);
  jobs.jobs.clear();
  const rejected = await plan(m);
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.error, /no bridge publication record/);
  policy.source_pins = { 'bridge/feature-job': source };
  assert.equal((await plan(m)).state, 'planned');
});

test('moved source or base invalidates the plan', async t => {
  for (const branch of ['bridge/feature-job', 'testing/passkeys']) {
    const f = await fixture(t); const r = await plan(f.m);
    await g(f.project, ['update-ref', `refs/heads/${branch}`, branch === 'testing/passkeys' ? f.source : f.main]);
    f.m.execute(r.id); const failed = await finish(f.m, r.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.error, /moved or disappeared/);
  }
});

test('policy changes and expiry fail closed', async t => {
  const { m, policy } = await fixture(t); const r = await plan(m);
  policy.checks[0].command = ['node', 'other-test'];
  m.execute(r.id); assert.match((await finish(m, r.id)).error, /policy changed/);
  const next = await plan(m);
  m.records.get(next.id).created_at = '2000-01-01T00:00:00Z';
  m.execute(next.id); assert.match((await finish(m, next.id)).error, /expired/);
});

test('baseline diagnostics remain visible but failing candidates cannot publish', async t => {
  const failure = [{ name: 'tests', exit_code: 1, stdout: 'specific failing test A', stderr: '' }];
  const { m } = await fixture(t, { dependencies: { validate: async () => structuredClone(failure) } });
  const r = await plan(m); m.execute(r.id); const result = await finish(m, r.id);
  assert.equal(result.state, 'validation_failed');
  assert.equal(result.validation.comparison[0].outcome, 'unchanged_failure');
  assert.throws(() => m.publish(r.id), /validation/);
});

test('equal failure counts with different diagnostics are changed failures', async t => {
  const { m } = await fixture(t, { dependencies: { validate: async (_dir, _sha, _checks, { phase }) =>
    [{ name: 'tests', exit_code: 1, stdout: phase === 'baseline' ? 'failure A' : 'failure B', stderr: '' }] } });
  const r = await plan(m); m.execute(r.id);
  assert.equal((await finish(m, r.id)).validation.comparison[0].outcome, 'new_or_changed_failure');
});

test('concurrent plans for the same target are refused; cancellation releases the lock', async t => {
  const { m } = await fixture(t);
  const args = { project: 'project', base_branch: 'testing/passkeys', sources: ['bridge/feature-job'] };
  const first = m.plan(args);
  assert.throws(() => m.plan(args), /another integration/);
  m.cancel(first.id); assert.equal((await finish(m, first.id)).state, 'cancelled');
  assert.equal((await plan(m)).state, 'planned');
});

test('remote creation race cannot overwrite even a fast-forward-compatible branch', async t => {
  const f = await fixture(t); const r = await plan(f.m);
  f.m.execute(r.id); await finish(f.m, r.id);
  const git = f.m.git;
  f.m.git = async (dir, args, opts) => {
    if (args[0] === 'push') await g(f.project, ['update-ref', `refs/heads/${r.candidate}`, f.base]);
    return git(dir, args, opts);
  };
  f.m.publish(r.id); const failed = await finish(f.m, r.id);
  assert.equal(failed.state, 'publication_failed');
  assert.equal(await g(f.project, ['rev-parse', r.candidate]), f.base);
});

test('PR failure retains the candidate and retries without another push', async t => {
  const f = await fixture(t); const r = await plan(f.m);
  f.m.execute(r.id); await finish(f.m, r.id);
  f.m.openPr = async () => { throw new Error('API unavailable'); };
  f.m.publish(r.id); const failed = await finish(f.m, r.id);
  assert.equal(failed.state, 'publication_failed'); assert.equal(failed.pushed, true);
  f.m.openPr = f.dependencies.openPr;
  f.m.publish(r.id); assert.equal((await finish(f.m, r.id)).state, 'published');
  assert.equal(f.calls.filter(a => a[0] === 'push').length, 1);
});

test('restart marks active records interrupted; completed records survive', async t => {
  const f = await fixture(t); const r = await plan(f.m);
  const stored = f.m.records.get(r.id); stored.state = 'publishing'; f.m.save(stored);
  const cleanup = [];
  const restarted = new IntegrationManager(f.cfg, f.jobs, { ...f.dependencies, run: async (...args) => { cleanup.push(args); return { code: 0 }; } });
  await restarted.init();
  assert.equal(restarted.get(r.id).state, 'interrupted');
  assert.equal(restarted.get(r.id).candidate_sha, r.candidate_sha);
  assert.equal(cleanup.length, 2);
  assert.throws(() => restarted.publish(r.id), /validation/);
});

test('protected destinations, revision expressions and foreign sources are refused', async t => {
  const { cfg, policy } = await fixture(t);
  const p = integrationPolicy(cfg, 'project');
  for (const name of ['main', 'master', 'develop', 'testing/other']) assert.throws(() => verifySelection(p, name, ['bridge/x'], 'develop'));
  policy.testing_branches.push('testing/protected'); policy.protected_branches = ['testing/protected'];
  assert.throws(() => verifySelection(policy, 'testing/protected', ['bridge/x'], 'main'), /protected/);
  assert.throws(() => verifySelection(p, 'testing/passkeys', ['feature/x'], 'main'), /sources/);
  for (const name of ['--upload-pack=x', 'refs/heads/main', 'main~1', 'bridge/../main', 'bridge/a.lock', 'bridge//a', 'bridge/a:main', 'bridge/a\nmain']) assert.throws(() => branchName(name));
  cfg.projects.project.integration.enabled = false;
  assert.throws(() => integrationPolicy(cfg, 'project'), /not enabled/);
});

test('process timeouts and output limits terminate commands', async () => {
  await assert.rejects(boundedRun('/bin/sh', ['-c', 'sleep 10'], { timeoutMs: 30 }), /timed out/);
  await assert.rejects(boundedRun('/bin/sh', ['-c', 'head -c 10000 /dev/zero'], { maxBytes: 100 }), /output exceeded/);
});

// Opt in on a host with Docker. No host mounts, network or credentials enter the container.
test('real container cannot see Git metadata, credentials, host files or external network', { skip: !process.env.BRIDGE_TEST_IMAGE }, async t => {
  const { m } = await fixture(t); const r = await plan(m);
  const checks = [{ name: 'isolation', image: process.env.BRIDGE_TEST_IMAGE, timeout_seconds: 20,
    command: ['node', '-e', `const fs=require('fs'),net=require('net');
      for(const p of ['.git','/root/.git-credentials','/var/run/docker.sock','/root/code']) if(fs.existsSync(p)) process.exit(1);
      if(process.getuid()===0) process.exit(2);
      fs.writeFileSync('scratch','works');
      try { fs.writeFileSync('/escape','bad'); process.exit(3); } catch {}
      const s=net.connect({host:'1.1.1.1',port:443}); s.setTimeout(1000); s.on('connect',()=>process.exit(4)); s.on('error',()=>process.exit(0)); s.on('timeout',()=>process.exit(0));`] }];
  const results = await validateSnapshot(m.directory(r), r.candidate_sha, checks, { id: r.id, phase: 'candidate' });
  assert.equal(results[0].exit_code, 0, results[0].stderr);
});

test('fetch failure never falls back to local refs', async t => {
  const f = await fixture(t); const git = f.m.git;
  f.m.git = (dir, args, opts) => args[0] === 'fetch' ? Promise.reject(new Error('fetch offline')) : git(dir, args, opts);
  const r = await plan(f.m);
  assert.equal(r.state, 'failed'); assert.match(r.error, /fetch offline/);
  assert.equal(f.calls.some(a => a[0] === 'merge'), false);
});

test('changing origin or making the testing base the default prevents execution', async t => {
  const f = await fixture(t); const r = await plan(f.m);
  await g(f.project, ['remote', 'set-url', 'origin', 'https://github.com/foreign/repo.git']);
  f.m.execute(r.id); assert.match((await finish(f.m, r.id)).error, /origin changed/);
  await g(f.project, ['remote', 'set-url', 'origin', origin]);
  f.m.metadata = async () => ({ default_branch: 'testing/passkeys' });
  const blocked = await plan(f.m);
  assert.equal(blocked.state, 'failed'); assert.match(blocked.error, /protected/);
});

test('cancelling validation aborts the runner and cannot publish partial results', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { dependencies: { validate: async (_dir, _sha, _checks, { signal }) => {
    entered();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } } });
  const r = await plan(f.m); f.m.execute(r.id); await started;
  f.m.cancel(r.id); assert.equal((await finish(f.m, r.id)).state, 'cancelled');
  assert.throws(() => f.m.publish(r.id), /validation/);
});

test('unpinned images and credential-bearing origins are refused', async t => {
  const { cfg, policy } = await fixture(t);
  policy.checks[0].image = 'node:latest';
  assert.throws(() => integrationPolicy(cfg, 'project'), /digest-pinned/);
  policy.checks[0].image = image;
  for (const url of ['file:///tmp/repo', 'https://token@github.com/example/project.git', 'https://github.com/example/project.git?x=1']) {
    policy.origin = url;
    assert.throws(() => integrationPolicy(cfg, 'project'), /credential-free/);
  }
});

test('local image IDs are immutable accepted pins; memory remains bounded', async t => {
  const { cfg, policy } = await fixture(t);
  policy.checks[0].image = `sha256:${'a'.repeat(64)}`;
  policy.checks[0].memory_mb = 4096;
  assert.equal(integrationPolicy(cfg, 'project').checks[0].memory_mb, 4096);
  for (const memory of [0, 511, 8193, '4096', 2048.5]) {
    policy.checks[0].memory_mb = memory;
    assert.throws(() => integrationPolicy(cfg, 'project'), /memory_mb/);
  }
  delete policy.checks[0].memory_mb;
  for (const image of ['sha256:abcd', 'node:latest', 'sha256:' + 'x'.repeat(64)]) {
    policy.checks[0].image = image;
    assert.throws(() => integrationPolicy(cfg, 'project'), /digest-pinned/);
  }
});

test('operator can serialize integrations across different targets', async t => {
  const { m, cfg, policy } = await fixture(t);
  cfg.integrations = { max_concurrent: 1 };
  policy.testing_branches.push('testing/another');
  const r = m.plan({ project: 'project', base_branch: 'testing/passkeys', sources: ['bridge/feature-job'] });
  assert.throws(() => m.plan({ project: 'project', base_branch: 'testing/another', sources: ['bridge/feature-job'] }), /concurrency limit/);
  await finish(m, r.id);
});
