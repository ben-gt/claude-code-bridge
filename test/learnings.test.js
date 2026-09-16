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

test('listing filters records, orders newest first, and paginates without losing evidence', t => {
  const { store, job } = fixture(t);
  const timestamp = new Date().toISOString();
  store.record({ ...job, id: 'first', finished_at: timestamp }, 'first observation');
  store.record({ ...job, id: 'second', finished_at: timestamp }, 'second observation');
  store.record({ ...job, id: 'other', project: 'other' }, 'other project');
  store.record({ ...job, id: 'old', finished_at: '2000-01-01T00:00:00.000Z' }, 'old observation');
  command(store, job);
  report(job);
  store.outcome(job);
  const all = store.list({ project: 'app' });
  assert.equal(all.total, 3);
  const first = store.list({ project: 'app', limit: 1 });
  const rest = store.list({ project: 'app', offset: first.next_offset });
  assert.deepEqual([...first.learnings, ...rest.learnings], all.learnings);
  assert.equal(rest.next_offset, null);
  assert.equal(store.list({ project: 'app', type: 'observation' }).total, 2);
  const lessons = store.list({ type: 'lesson' });
  assert.equal(lessons.total, 1);
  assert.equal(lessons.learnings[0].lesson.check.passed, true);
  assert.match(lessons.learnings[0].source, /stream.jsonl/);
  assert.equal(store.list({ include_stale: true }).total, 5);
  assert.equal(store.list({ include_stale: true }).learnings.at(-1).stale, true);
  assert.equal(store.list({ offset: 100 }).next_offset, null);
  assert.equal(store.list({ project: 'missing' }).total, 0);
});

test('listing reports invalid records, scrubs newly registered secrets, and respects disabled storage', t => {
  const { store, cfg, job } = fixture(t);
  assert.equal(store.list().total, 0);
  store.record(job, 'listing-late-secret');
  addSecret('listing-late-secret');
  fs.writeFileSync(path.join(store.dir, 'observations', 'invalid.md'), 'bad');
  assert.equal(store.list().rejected_count, 1);
  assert.doesNotMatch(JSON.stringify(store.list()), /listing-late-secret/);
  const disabled = new Learnings({ ...cfg, learnings: { ...cfg.learnings, enabled: false } });
  assert.deepEqual(disabled.list(), { enabled: false, learnings: [], total: 0, offset: 0, next_offset: null, rejected_count: 0 });
  for (const options of [{ limit: 0 }, { limit: 21 }, { offset: -1 }, { offset: 0.5 }, { type: 'invalid' }, { include_stale: 'yes' }]) {
    assert.throws(() => store.list(options));
  }
});

test('listing byte limit shortens pages and supplies a continuation', t => {
  const { store, job } = fixture(t);
  for (let i = 0; i < 20; i++) store.record({ ...job, id: `large_${i}` }, '界'.repeat(2000));
  const page = store.list({ limit: 20 });
  assert.ok(page.learnings.length > 0 && page.learnings.length < 20);
  assert.equal(page.next_offset, page.learnings.length);
  const next = store.list({ limit: 20, offset: page.next_offset });
  assert.equal(page.learnings.length + next.learnings.length, 20);
});

test('list_learnings works through the MCP client, validates input and returns structured errors', async t => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerTools } = await import('../src/tools.js');
  const { DEFAULTS } = await import('../src/config.js');
  const { store, job } = fixture(t);
  store.record(job, 'MCP evidence');
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTools(server, { cfg: DEFAULTS, projects: {}, jobs: { learnings: store }, log: quiet });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.equal(listed.tools.find(tool => tool.name === 'list_learnings').annotations.readOnlyHint, true);
  const result = await client.callTool({ name: 'list_learnings', arguments: { project: 'app' } });
  assert.equal(result.structuredContent.learnings[0].observation, 'MCP evidence');
  const invalid = await client.callTool({ name: 'list_learnings', arguments: { limit: 21 } });
  assert.equal(invalid.isError, true);
  t.mock.method(store, 'read', () => { throw new Error('evidence scan failed'); });
  const failed = await client.callTool({ name: 'list_learnings', arguments: {} });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /evidence scan failed/);
});
