// Regressions from the 2026-11-08/09 demo jobs: sessions that had finished their work were
// reported as failed with an empty result, and stopped jobs could only be started again from nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobManager } from '../src/jobs.js';
import { DEFAULTS } from '../src/config.js';
import { storedName, validateTicketInput } from '../src/ticket-inputs.js';

function fixture(t, { remote = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'app');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'testing/passkeys');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'before');
  git('add', '.'); git('commit', '-qm', 'initial');
  let origin = null;
  if (remote) {
    origin = path.join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'testing/passkeys', origin]);
    git('remote', 'add', 'origin', origin); git('push', '-qu', 'origin', 'testing/passkeys');
  }
  const cfg = { ...structuredClone(DEFAULTS), workspace_root: root, data_dir: path.join(root, '.jobs'), execution_branch: 'testing/passkeys' };
  const m = new JobManager(cfg, {}, { log: { info() {}, error() {}, warn() {} } });
  m.pump = () => {};
  t.after(() => { for (const timer of m.writeTimers.values()) clearTimeout(timer); });
  const commit = (file, content, message = file) => { fs.writeFileSync(path.join(repo, file), content); git('add', file); git('commit', '-qm', message); };
  const originHead = () => execFileSync('git', ['--git-dir', origin, 'rev-parse', 'testing/passkeys'], { encoding: 'utf8' }).trim();
  return { m, git, repo, commit, originHead };
}

const MODEL_USAGE = { 'claude-opus-5': { inputTokens: 118, outputTokens: 48450, cacheReadInputTokens: 2952411, cacheCreationInputTokens: 327739, costUSD: 5.0677 } };
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const say = (m, job, text, parent) => m.handleEvent(job, JSON.stringify({ type: 'assistant', parent_tool_use_id: parent || null, message: { content: [{ type: 'text', text }] } }));
const result = (m, job, extra) => m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 1, modelUsage: MODEL_USAGE, usage: ZERO_USAGE, ...extra }));
const budgetStop = (m, job, cost = 5.0677) => m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 1, total_cost_usd: cost, errors: ['Reached maximum budget ($5)'], modelUsage: MODEL_USAGE, usage: ZERO_USAGE }));

async function run(f, mode, script) {
  const { job_id } = await f.m.start({ project: 'app', prompt: 'Fix', mode });
  const j = f.m.get(job_id); j.state = 'running';
  f.m.spawnClaude = async job => (await script(job)) || { code: 0 };
  await f.m.runJob(j);
  return j;
}

test('a plan delivered before the cost ceiling is kept, and the job completes (6BBMTLE0)', async t => {
  const f = fixture(t);
  const plan = '## Plan\n' + 'Replace the free-text location with the map picker. '.repeat(40);
  const addendum = 'Two sub-agent reports arrived after the plan and change one step: reuse src/lib/address-lookup.ts.';
  const j = await run(f, 'plan', job => {
    result(f.m, job, { result: plan });
    result(f.m, job, { result: addendum });
    result(f.m, job, { result: '' });
    budgetStop(f.m, job);
  });
  assert.equal(j.state, 'completed');
  assert.equal(j.error, null);
  assert.ok(j.result_text.startsWith('## Plan'));
  assert.ok(j.result_text.includes(addendum));
  assert.equal(fs.readFileSync(j.plan_file, 'utf8').trim(), j.result_text);
  assert.ok(j.notes.some(n => /cost ceiling after the agent had delivered/.test(n)));
  assert.deepEqual(j.usage, { input_tokens: 118, output_tokens: 48450, cache_creation_input_tokens: 327739, cache_read_input_tokens: 2952411 });
});

test('the plan is the substantive result, not a closing "delivered above" recap (BVGUXXTA)', async t => {
  const f = fixture(t);
  const plan = '# Implementation plan\n' + 'PersonCard becomes an avatar tile with a score ring. '.repeat(60);
  const j = await run(f, 'plan', job => {
    result(f.m, job, { result: '' });
    result(f.m, job, { result: plan });
    result(f.m, job, { result: 'Planning is complete. The full plan was delivered in my previous message.' });
  });
  assert.equal(j.state, 'completed');
  assert.ok(fs.readFileSync(j.plan_file, 'utf8').startsWith('# Implementation plan'));
  // The status a chat reads carries the whole plan, not the first 4,000 characters of it.
  assert.equal(f.m.status(j.id).result, j.result_text);
  assert.equal(f.m.status(j.id).result_truncated, undefined);
  j.result_text = 'x'.repeat(20500);
  assert.equal(f.m.status(j.id).result.length, 20000);
  assert.match(f.m.status(j.id).result_truncated, /20000 of 20500/);
});

test('finished work is published when the session only overran the time limit (436I5C5G)', async t => {
  const f = fixture(t, { remote: true });
  const j = await run(f, 'execute', job => {
    f.commit('fix.txt', 'fixed');
    result(f.m, job, { result: 'Tests are running; I will report when they finish.' });
    result(f.m, job, { result: 'Done. Both commits are on testing/passkeys and the working tree is clean.\n' + 'Summary. '.repeat(30) });
    return { code: null, timedOut: true };
  });
  assert.equal(j.state, 'completed');
  assert.equal(j.pushed, true);
  assert.equal(f.originHead(), f.git('rev-parse', 'HEAD'));
  assert.ok(j.result_text.startsWith('Done. Both commits'));
});

test('a job stopped at its cost ceiling reports how far it got and how to finish it', async t => {
  const f = fixture(t, { remote: true });
  const j = await run(f, 'execute', job => {
    job.session_id = 'sess-1';
    f.commit('part.txt', 'half');
    say(f.m, job, 'A sub-agent note that is not the agent speaking.', 'toolu_1');
    say(f.m, job, 'Schema and API are committed. Now the full test suite:');
    budgetStop(f.m, job, 12.0519);
  });
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'cost_ceiling');
  assert.match(j.error, /before the agent gave a final result; 1 commit\(s\) pushed to testing\/passkeys/);
  assert.match(j.result_text, /Schema and API are committed\. Now the full test suite:/);
  assert.doesNotMatch(j.result_text, /sub-agent note/);
  assert.notEqual(j.result_text, '""');
  const status = f.m.status(j.id);
  assert.match(status.next_step, new RegExp(`continue_task with job_id ${j.id}`));
  assert.equal(status.usage.cache_read_input_tokens, 2952411);
});

test('a stopped plan job leaves no empty plan file behind', async t => {
  const f = fixture(t);
  const j = await run(f, 'plan', job => { say(f.m, job, 'Reading the screen component.'); budgetStop(f.m, job); });
  assert.equal(j.state, 'failed');
  assert.equal(j.plan_file, null);
  assert.equal(fs.existsSync(path.join(f.m.jobDir(j.id), 'plan.md')), false);
  assert.match(j.error, /nothing was changed \(plan mode\)/);
});

test('continue_task resumes the stopped session with its unfinished edits in place', async t => {
  const f = fixture(t, { remote: true });
  const first = await run(f, 'execute', job => {
    job.session_id = 'sess-42';
    f.commit('done.txt', 'committed');
    fs.writeFileSync(path.join(f.repo, 'wip.txt'), 'unfinished');
    say(f.m, job, 'Halfway through the second change.');
    budgetStop(f.m, job);
  });
  assert.equal(first.state, 'failed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'wip.txt'), 'utf8'), 'unfinished');
  // A fresh start is still refused on the dirty tree; the continuation is the way through.
  await assert.rejects(f.m.start({ project: 'app', prompt: 'Something else', mode: 'execute' }), /uncommitted changes/);

  const r = await f.m.continueJob({ job_id: first.id });
  const next = f.m.get(r.job_id); next.state = 'running';
  assert.equal(next.continues, first.id);
  assert.equal(f.m.get(first.id).continued_by, next.id);
  assert.equal(r.spent_so_far_usd, 5.0677);
  let args;
  f.m.spawnClaude = async (job, a) => {
    args = a;
    f.commit('wip.txt', 'finished');
    // A resumed session reports its whole life: the stopped run's $5.0677 plus this run's $2.
    result(f.m, job, { result: 'Finished the second change; tests pass.', total_cost_usd: 7.0677, modelUsage: { 'claude-opus-5': { inputTokens: 130, outputTokens: 50000, cacheReadInputTokens: 3952411, cacheCreationInputTokens: 327739 } } });
    return { code: 0 };
  };
  await f.m.runJob(next);
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-42');
  assert.equal(next.state, 'completed');
  assert.equal(next.pushed, true);
  assert.equal(f.originHead(), f.git('rev-parse', 'HEAD'));
  assert.equal(next.cost_usd, 2);
  assert.equal(next.session_cost_usd, 7.0677);
  assert.deepEqual(next.usage, { input_tokens: 12, output_tokens: 1550, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000000 });
  assert.equal(f.m.status(next.id).cost_total_usd, 7.0677);
  assert.equal(f.m.status(first.id).next_step, undefined);
  await assert.rejects(f.m.continueJob({ job_id: first.id }), /already continued/);
});

test('continue_task refuses edits that are not the stopped job\'s own', async t => {
  const f = fixture(t);
  const plan = await run(f, 'plan', job => { job.session_id = 'sess-7'; budgetStop(f.m, job); });
  fs.writeFileSync(path.join(f.repo, 'someone-else.txt'), 'theirs');
  await assert.rejects(f.m.continueJob({ job_id: plan.id }), /do not belong/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'someone-else.txt'), 'utf8'), 'theirs');
  await assert.rejects(f.m.continueJob({ job_id: 'j_missing' }), /unknown job_id/);
});

test('jobs run in the foreground with no connectors and no wake-ups', async t => {
  const f = fixture(t);
  for (const mode of ['plan', 'execute']) {
    const { job_id } = await f.m.start({ project: 'app', prompt: 'Check', mode });
    const job = f.m.get(job_id);
    job.branch = 'testing/passkeys';
    const args = f.m.claudeArgs(job, { remote: false });
    assert.ok(args.includes('--strict-mcp-config'), mode);
    const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--strict-mcp-config'));
    for (const tool of ['ScheduleWakeup', 'CronCreate', 'Monitor']) assert.ok(denied.includes(tool), `${mode} ${tool}`);
    assert.equal(denied.includes('Bash'), mode === 'plan');
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /never in the background/);
    job.state = 'cancelled';
  }
});

test('attachments are stored under names an agent can type back', () => {
  assert.equal(storedName('Screenshot 2026-11-09 at 10.43.26 am.png'), 'Screenshot_2026-11-09_at_10.43.26_am.png');
  assert.equal(storedName('proof.txt'), 'proof.txt');
  assert.equal(storedName('  '), 'attachment');
  const input = validateTicketInput({ ticket_id: '6BBMTLE0', text: 'x', attachments: [{ filename: 'Screenshot 2026-11-09 at 10.43.26 am.png', data_base64: Buffer.from('png').toString('base64') }] });
  assert.equal(input.attachments[0].stored_name, '1-Screenshot_2026-11-09_at_10.43.26_am.png');
  assert.equal(input.attachments[0].filename, 'Screenshot 2026-11-09 at 10.43.26 am.png');
});
