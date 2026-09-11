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
