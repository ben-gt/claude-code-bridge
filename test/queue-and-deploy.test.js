// The 2026-11-10 workflow fixes: jobs on a busy project queue instead of being refused, a stopped job's
// unfinished edits are parked so they do not block the queue, and an execute job deploys what it pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobManager } from '../src/jobs.js';
import { DEFAULTS } from '../src/config.js';

const BRANCH = 'testing/passkeys';

function fixture(t, { projects = ['app'], remote = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repos = {};
  for (const name of projects) {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', BRANCH);
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'before');
    git('add', '.'); git('commit', '-qm', 'initial');
    if (remote) {
      const origin = path.join(root, `${name}-origin.git`);
      execFileSync('git', ['init', '--bare', '-q', '-b', BRANCH, origin]);
      git('remote', 'add', 'origin', origin); git('push', '-qu', 'origin', BRANCH);
    }
    repos[name] = { repo, git, commit: (file, content) => { fs.writeFileSync(path.join(repo, file), content); git('add', file); git('commit', '-qm', file); return git('rev-parse', 'HEAD'); } };
  }
  const cfg = { ...structuredClone(DEFAULTS), workspace_root: root, data_dir: path.join(root, '.jobs'), execution_branch: BRANCH };
  const m = new JobManager(cfg, {}, { log: { info() {}, error() {}, warn() {} } });
  t.after(() => { for (const timer of m.writeTimers.values()) clearTimeout(timer); });
  return { m, cfg, root, ...repos.app, repos };
}

const tick = () => new Promise(r => setImmediate(r));
const MODEL_USAGE = { 'claude-opus-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 1 } };
const result = (m, job, text) => m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 1, modelUsage: MODEL_USAGE, result: text }));
const budgetStop = (m, job) => m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 1, total_cost_usd: 5, modelUsage: MODEL_USAGE }));
const say = (m, job, text) => m.handleEvent(job, JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }));

test('a second job on a busy project queues behind the first and starts by itself when it finishes', async t => {
  const f = fixture(t);
  f.cfg.limits.max_concurrent_jobs = 3;
  const order = [];
  let release;
  f.m.spawnClaude = async job => { order.push(job.id); await new Promise(r => { release = r; }); result(f.m, job, 'done'); return { code: 0 }; };
  const first = await f.m.start({ project: 'app', prompt: 'First', mode: 'execute' });
  for (let i = 0; i < 100 && !order.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.m.get(first.job_id).state, 'running');
  // The checkout is busy (first is working in it) — the second job is accepted and waits, not refused.
  fs.writeFileSync(path.join(f.repo, 'half.txt'), 'first job mid-edit');
  const second = await f.m.start({ project: 'app', prompt: 'Second', mode: 'execute' });
  assert.equal(second.state, 'queued');
  assert.equal(second.queue_position, 1);
  assert.equal(second.waiting_for, first.job_id);
  assert.match(second.note, /starts by itself/);
  const third = await f.m.start({ project: 'app', prompt: 'Third', mode: 'plan' });
  assert.equal(third.queue_position, 2);
  assert.equal(third.waiting_for, second.job_id);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(order, [first.job_id], 'nothing else starts while the project is busy');
  assert.equal(f.m.status(second.job_id).state, 'queued');
  assert.match(f.m.status(second.job_id).hint, /starts by itself/);
  fs.rmSync(path.join(f.repo, 'half.txt'));
  release();
  for (let i = 0; i < 100 && order.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.m.get(first.job_id).state, 'completed');
  assert.equal(f.m.get(second.job_id).state, 'running');
  assert.equal(f.m.get(third.job_id).state, 'queued', 'third waits for second in turn');
  assert.equal(order[1], second.job_id);
  release();
  for (let i = 0; i < 100 && order.length < 3; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(order[2], third.job_id);
  release();
  for (let i = 0; i < 100 && f.m.get(third.job_id).state === 'running'; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.m.get(third.job_id).state, 'completed');
});

test('jobs on different projects still run side by side', async t => {
  const f = fixture(t, { projects: ['app', 'other'] });
  f.cfg.limits.max_concurrent_jobs = 3;
  const running = new Set();
  f.m.spawnClaude = async job => { running.add(job.id); await new Promise(() => {}); };
  const a = await f.m.start({ project: 'app', prompt: 'A', mode: 'plan' });
  const b = await f.m.start({ project: 'other', prompt: 'B', mode: 'plan' });
  for (let i = 0; i < 100 && running.size < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual([...running].sort(), [a.job_id, b.job_id].sort());
  assert.equal(a.waiting_for, undefined);
  for (const id of [a.job_id, b.job_id]) f.m.get(id).state = 'cancelled';
});

test('a queued job that finds strangers\' edits in the checkout fails with a named reason and leaves them alone', async t => {
  const f = fixture(t);
  f.m.pump = () => {};
  const { job_id } = await f.m.start({ project: 'app', prompt: 'Fix', mode: 'execute' });
  const j = f.m.get(job_id); j.state = 'running';
  fs.writeFileSync(path.join(f.repo, 'theirs.txt'), 'somebody else');
  f.m.spawnClaude = () => { throw new Error('must not run'); };
  await f.m.runJob(j);
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'dirty_tree');
  assert.match(j.error, /theirs\.txt/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'theirs.txt'), 'utf8'), 'somebody else');
});

test('parked edits that no longer apply are left on their ref and the agent is told where', async t => {
  const f = fixture(t);
  f.m.pump = () => {};
  const start = async (opts, script) => {
    const r = opts.job_id ? await f.m.continueJob(opts) : await f.m.start({ project: 'app', mode: 'execute', ...opts });
    const j = f.m.get(r.job_id); j.state = 'running';
    f.m.spawnClaude = async (job, args) => (await script(job, args)) || { code: 0 };
    await f.m.runJob(j);
    return j;
  };
  const stopped = await start({ prompt: 'Fix' }, job => { job.session_id = 's1'; fs.writeFileSync(path.join(f.repo, 'file.txt'), 'half done'); say(f.m, job, 'midway'); budgetStop(f.m, job); });
  assert.equal(stopped.state, 'failed');
  assert.equal(f.git('status', '--porcelain'), '');
  // Meanwhile another job rewrites the same file, so the parked edit conflicts.
  const other = await start({ prompt: 'Other' }, job => { f.commit('file.txt', 'rewritten by another job'); result(f.m, job, 'ok'); });
  assert.equal(other.state, 'completed');
  let prompt;
  const resumed = await start({ job_id: stopped.id }, (job, args) => { prompt = args[args.indexOf('--append-system-prompt') + 1]; result(f.m, job, 'reapplied by hand'); });
  assert.equal(resumed.state, 'completed');
  assert.equal(resumed.parked_conflict, stopped.parked_ref);
  assert.match(prompt, /could not be reapplied automatically/);
  assert.match(prompt, new RegExp(`git diff HEAD ${stopped.parked_ref}`));
  assert.equal(f.git('show', `${stopped.parked_ref}:file.txt`), 'half done');
  assert.equal(f.git('status', '--porcelain'), '', 'a failed reapply leaves the checkout clean');
});

function deployFixture(t, script) {
  const f = fixture(t);
  f.m.pump = () => {};
  const bin = path.join(f.root, 'deploy.sh');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  f.cfg.projects = { app: { deploy: { auto: true, command: [bin], timeout_minutes: 1 } } };
  return { ...f, bin };
}
async function executeJob(f, script, opts = {}) {
  const { job_id, ...rest } = await f.m.start({ project: 'app', prompt: 'Fix', mode: 'execute', ...opts });
  const j = f.m.get(job_id); j.state = 'running';
  f.m.spawnClaude = async job => (await script(job)) || { code: 0 };
  await f.m.runJob(j);
  return Object.assign(j, { _start: rest });
}

test('an execute job that pushed commits deploys them and says so in its result', async t => {
  const f = deployFixture(t, 'echo "== building $BRIDGE_PROJECT at $BRIDGE_SHA"; echo "job=$BRIDGE_JOB ticket=$BRIDGE_TICKET" > "$(dirname "$0")/deployed.txt"; echo "== live"');
  const j = await executeJob(f, job => { f.commit('fix.txt', 'fixed'); result(f.m, job, 'Fixed the thing.'); }, { ticket_context: { ticket_id: 'ABCDEFGH', text: 'x', attachments: [] } });
  assert.equal(j._start.deploys_when_done, true);
  assert.equal(j.state, 'completed');
  assert.equal(j.pushed, true);
  assert.equal(j.deploy.state, 'deployed');
  assert.equal(j.deploy.sha, f.git('rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(f.root, 'deployed.txt'), 'utf8').trim(), `job=${j.id} ticket=ABCDEFGH`);
  assert.match(j.result_text, /^Fixed the thing\./);
  assert.match(j.result_text, /## Deployment\n\nDeployed to the demo: app at [0-9a-f]{10} is live/);
  assert.ok(j.notes.some(n => /^deployed [0-9a-f]{10} to the demo$/.test(n)));
  const status = f.m.status(j.id);
  assert.equal(status.deploy.state, 'deployed');
  assert.match(f.m.claudeArgs(j, { remote: true })[f.m.claudeArgs(j, { remote: true }).indexOf('--append-system-prompt') + 1], /deploys it to the demo site itself/);
});

test('a failed deploy leaves the job completed with its commits pushed and the failure in the result', async t => {
  const f = deployFixture(t, 'echo "== building"; echo "tsc: error TS2345 in src/x.ts" >&2; exit 3');
  const j = await executeJob(f, job => { f.commit('fix.txt', 'fixed'); result(f.m, job, 'Fixed.'); });
  assert.equal(j.state, 'completed');
  assert.equal(j.pushed, true);
  assert.equal(j.deploy.state, 'failed');
  assert.match(j.deploy.error, /exited 3/);
  assert.match(j.result_text, /NOT deployed: deploy command exited 3\. The commits are pushed to testing\/passkeys; the change is not live yet\.\n[\s\S]*TS2345/);
});

test('nothing is deployed for a job without commits, with deploy=false, or in plan mode', async t => {
  const f = deployFixture(t, 'echo ran > "$(dirname "$0")/ran.txt"');
  const none = await executeJob(f, job => { result(f.m, job, 'Nothing to change.'); });
  assert.equal(none.state, 'completed');
  assert.equal(none.deploy, undefined);
  assert.ok(none.notes.includes('nothing to deploy: no commits'));
  const off = await executeJob(f, job => { f.commit('a.txt', 'a'); result(f.m, job, 'Done.'); }, { deploy: false });
  assert.equal(off._start.deploys_when_done, undefined);
  assert.equal(off.deploy, undefined);
  const { job_id } = await f.m.start({ project: 'app', prompt: 'Look', mode: 'plan' });
  assert.equal(f.m.get(job_id).deploy_wanted, false);
  assert.equal(fs.existsSync(path.join(f.root, 'ran.txt')), false);
  await assert.rejects(f.m.start({ project: 'app', prompt: 'x', mode: 'execute', deploy: 'yes' }), /deploy must be true or false/);
});

test('a stopped job does not deploy, and its continuation deploys once the work is finished', async t => {
  const f = deployFixture(t, 'echo "== live"');
  const stopped = await executeJob(f, job => { job.session_id = 's9'; f.commit('part.txt', 'half'); say(f.m, job, 'halfway'); budgetStop(f.m, job); });
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.deploy, undefined);
  const r = await f.m.continueJob({ job_id: stopped.id });
  const next = f.m.get(r.job_id); next.state = 'running';
  f.m.spawnClaude = async job => { f.commit('part.txt', 'whole'); result(f.m, job, 'Finished.'); return { code: 0 }; };
  await f.m.runJob(next);
  assert.equal(next.state, 'completed');
  assert.equal(next.deploy.state, 'deployed');
});
