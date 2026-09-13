import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Learnings } from '../src/learnings.js';
import { JobManager } from '../src/jobs.js';
import { addSecret } from '../src/scrub.js';

const quiet = { info() {}, warn() {}, error() {} };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-learnings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { data_dir: dir, limits: {}, claude: {}, learnings: { dir: path.join(dir, 'learnings') } };
  return { cfg, store: new Learnings(cfg, { log: quiet }), job: { id: 'j_test', project: 'app', kind: 'codex', mode: 'execute', notes: [], state: 'running', limits: { timeout_minutes: 10 } } };
}

test('evidence survives restart, is scrubbed, and is scoped to project/engine/mode', t => {
  const { cfg, store, job } = fixture(t);
  addSecret('private-learning-value');
  store.record(job, 'command failed with private-learning-value');
  const restored = new Learnings(cfg);
  const context = restored.context(job);
  assert.match(context, /command failed/);
  assert.doesNotMatch(context, /private-learning-value/);
  assert.equal(restored.context({ ...job, project: 'other' }), '');
  assert.equal(restored.context({ ...job, kind: 'claude' }), '');
  assert.equal(restored.context({ ...job, mode: 'plan' }), '');
});

test('maintenance consolidates exact repeats without changing evidence and excludes stale data', t => {
  const { store, job } = fixture(t);
  store.record(job, 'same failure');
  store.record(job, 'same failure');
  store.record({ ...job, id: 'j_second' }, 'same failure');
  store.record({ ...job, id: 'j_old', finished_at: '2000-01-01T00:00:00.000Z' }, 'old failure');
  const before = store.read();
  const report = store.maintain();
  assert.equal(report.records, 3);
  assert.equal(report.groups, 2);
  assert.equal(report.stale, 1);
  assert.deepEqual(store.read(), before);
  assert.match(store.context(job), /"occurrences":2/);
  assert.doesNotMatch(store.context(job), /old failure/);
  assert.match(fs.readFileSync(path.join(store.dir, 'INDEX.md'), 'utf8'), /old failure/);
});

test('tampered and malformed evidence is excluded with a maintenance error report', t => {
  const { store, job } = fixture(t);
  store.record(job, 'original');
  const file = path.join(store.dir, 'observations', store.read().records[0].file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('original', 'invented'));
  fs.writeFileSync(path.join(store.dir, 'observations', 'invalid.md'), 'bad');
  assert.equal(store.context(job), '');
  assert.equal(store.maintain().rejected.length, 2);
});

test('successful jobs retain observed tool failures without promoting assistant claims', t => {
  const { cfg, job } = fixture(t);
  const manager = new JobManager(cfg, {}, { log: quiet });
  manager.save = () => {};
  manager.pump = () => {};
  manager.handleCodexEvent(job, JSON.stringify({ type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'missing dependency' } }));
  manager.handleEvent({ ...job, kind: 'claude' }, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', is_error: true, content: 'permission denied' }] } }));
  job.result_text = 'I assume reinstalling fixes everything';
  manager.finish(job, 'completed');
  assert.equal(manager.learnings.read().records.length, 2);
  assert.match(manager.learnings.context(job), /missing dependency/);
  assert.doesNotMatch(manager.learnings.context(job), /reinstalling/);
  assert.match(manager.systemPrompt(job, { remote: false }), /HISTORICAL EVIDENCE/);
});

test('tool capture and prompt payload are bounded; disabled store writes nothing', t => {
  const { cfg, store, job } = fixture(t);
  for (let i = 0; i < 30; i++) store.event(job, { type: 'item.completed', item: { id: String(i), type: 'command_execution', command: 'test', exit_code: 1, aggregated_output: 'x'.repeat(4000) } });
  assert.equal(store.read().records.length, 20);
  assert.ok(store.context(job).length < 6500);
  const disabled = new Learnings({ ...cfg, learnings: { enabled: false, dir: path.join(cfg.data_dir, 'disabled') } });
  disabled.record(job, 'failure');
  assert.equal(disabled.context(job), '');
  assert.deepEqual(disabled.maintain(), { disabled: true });
  assert.equal(fs.existsSync(disabled.dir), false);
});

function report(job, overrides = {}) {
  job.state = 'completed';
  job.result_text = '```bridge-learnings\n' + JSON.stringify([{
    topic: 'Dependency setup', problem: 'Tests need dependencies', change: 'Installed dependencies',
    verification: 'npm test', environment: 'Node 22, revision abc123', scope: 'project', ...overrides,
  }]) + '\n```';
}

function command(store, job, exit_code = 0) {
  store.event(job, { type: 'item.completed', item: { id: 'check', type: 'command_execution', command: 'npm test', exit_code, aggregated_output: 'test output' } });
}

test('verified lessons survive restart, cross engine/mode within project, and appear in topic index', t => {
  const { store, cfg, job } = fixture(t);
  command(store, job);
  report(job);
  store.outcome(job);
  const restored = new Learnings(cfg);
  assert.match(restored.context({ ...job, kind: 'claude', mode: 'plan' }), /Installed dependencies/);
  assert.equal(restored.context({ ...job, project: 'other' }), '');
  const record = restored.read().records[0];
  assert.equal(record.lesson.check.status, 'exit 0');
  assert.equal(record.lesson.check.output, 'test output');
  restored.maintain();
  assert.match(fs.readFileSync(path.join(store.dir, 'INDEX.md'), 'utf8'), /dependency setup/);
  restored.outcome(job);
  assert.equal(restored.read().records.length, 1);
});

test('unverified, failed, superseded, and incomplete job lessons are not accepted', t => {
  for (const scenario of ['missing', 'failure', 'superseded', 'incomplete', 'malformed']) {
    const { store, job } = fixture(t);
    if (scenario !== 'missing') command(store, job);
    if (scenario === 'failure' || scenario === 'superseded') command(store, job, 1);
    report(job);
    if (scenario === 'incomplete') job.state = 'failed';
    if (scenario === 'malformed') job.result_text = '```bridge-learnings\n[invalid]\n```';
    store.outcome(job);
    assert.equal(store.read().records.filter(r => r.lesson).length, 0, scenario);
  }
});

test('Claude lessons require matching Bash invocation and explicit non-error result', t => {
  const { store, job } = fixture(t);
  job.kind = 'claude';
  store.event(job, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'npm test' } }] } });
  store.event(job, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash1', is_error: false, content: 'passed' }] } });
  report(job, { scope: 'engine' });
  store.outcome(job);
  assert.match(store.context({ ...job, mode: 'plan' }), /Installed dependencies/);
  assert.equal(store.context({ ...job, kind: 'codex' }), '');
});

test('lesson metadata is scrubbed, hash protected, and expires', t => {
  const { store, job } = fixture(t);
  addSecret('lesson-secret-value');
  command(store, job);
  report(job, { change: 'lesson-secret-value' });
  store.outcome(job);
  const record = store.read().records[0];
  assert.doesNotMatch(JSON.stringify(record), /lesson-secret-value/);
  const file = path.join(store.dir, 'observations', record.file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Node 22', 'Node 23'));
  assert.equal(store.read().rejected.length, 1);
  const fresh = fixture(t);
  command(fresh.store, fresh.job);
  report(fresh.job);
  fresh.job.finished_at = '2000-01-01T00:00:00.000Z';
  fresh.store.outcome(fresh.job);
  assert.equal(fresh.store.context(fresh.job), '');
});

test('lesson report limits reject oversized fields and evicted verification explicitly', t => {
  const { store, job } = fixture(t);
  const warnings = [];
  store.log = { warn: message => warnings.push(message) };
  command(store, job);
  for (let i = 0; i < 100; i++) {
    store.event(job, { type: 'item.completed', item: { id: String(i), type: 'command_execution', command: `check ${i}`, exit_code: 0 } });
  }
  report(job);
  store.outcome(job);
  assert.equal(store.read().records.length, 0);
  assert.match(warnings[0], /no matching successful tool result/);
  command(store, job);
  report(job, { change: 'x'.repeat(1001) });
  store.outcome(job);
  assert.equal(store.read().records.length, 0);
  assert.match(warnings[1], /invalid lesson fields/);
});
