import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs.js';

const quiet = { info() {}, warn() {}, error() {} };

function mgr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'));
  return new JobManager(
    { data_dir: dir, limits: { max_concurrent_jobs: 2 }, claude: {}, models: {} },
    { all: () => [] },
    { log: quiet },
  );
}
const job = (id, state, o = {}) => ({ id, state, project: `p-${id}`, depends_on: null, ...o });

test('a job with no dependencies is never blocked', () => {
  const m = mgr();
  assert.equal(m.blockedBy(job('j_a', 'queued')), null);
  assert.equal(m.blockedBy(job('j_a', 'queued', { depends_on: [] })), null);
});

test('an unfinished predecessor blocks; a finished one releases', () => {
  const m = mgr();
  m.jobs.set('j_dep', job('j_dep', 'running'));
  const child = job('j_kid', 'queued', { depends_on: ['j_dep'] });
  assert.match(m.blockedBy(child), /p-j_dep \(j_dep\)/);

  m.jobs.get('j_dep').state = 'queued';
  assert.ok(m.blockedBy(child), 'a queued predecessor still blocks');

  m.jobs.get('j_dep').state = 'completed';
  assert.equal(m.blockedBy(child), null, 'completed releases');
});

test('a FAILED predecessor releases the dependent rather than stranding it', () => {
  const m = mgr();
  for (const st of ['failed', 'cancelled', 'interrupted']) {
    m.jobs.set('j_dep', job('j_dep', st));
    assert.equal(m.blockedBy(job('j_kid', 'queued', { depends_on: ['j_dep'] })), null, st);
  }
});

test('an unknown predecessor blocks, and is named as unknown', () => {
  const m = mgr();
  assert.match(m.blockedBy(job('j_kid', 'queued', { depends_on: ['j_ghost'] })), /j_ghost \(unknown job\)/);
});

test('the first unmet predecessor is the one reported', () => {
  const m = mgr();
  m.jobs.set('j_1', job('j_1', 'completed'));
  m.jobs.set('j_2', job('j_2', 'running'));
  m.jobs.set('j_3', job('j_3', 'queued'));
  const r = m.blockedBy(job('j_kid', 'queued', { depends_on: ['j_1', 'j_2', 'j_3'] }));
  assert.match(r, /j_2/);
  assert.doesNotMatch(r, /j_3/);
});

test('quota failover: a session-limit failure requeues once, a task failure does not', () => {
  const m = mgr();
  m.cfg.failover = { enabled: true, api_key: 'sk-ant-test' };
  const j = { id: 'j_q', state: 'running', project: 'bnd-flux', activity: 'x', depends_on: null };
  m.jobs.set(j.id, j);

  m.finish(j, 'failed', "claude reported an error: You've hit your session limit · resets 11:10am (UTC)");
  assert.equal(j.state, 'queued', 'requeued rather than failed');
  assert.equal(j.failover_used, true);
  assert.equal(j.error, null, 'the quota error is not left on the record');

  // Second time round it must actually fail — no infinite loop.
  j.state = 'running';
  m.finish(j, 'failed', 'You have hit your session limit again');
  assert.equal(j.state, 'failed', 'failover happens at most once');

  // A genuine task failure never triggers it.
  const t = { id: 'j_t', state: 'running', project: 'p', depends_on: null };
  m.jobs.set(t.id, t);
  m.finish(t, 'failed', 'the test suite failed');
  assert.equal(t.state, 'failed');
  assert.ok(!t.failover_used);
});

test('quota failover stays off unless enabled and keyed', () => {
  for (const fo of [{}, { enabled: true }, { api_key: 'k' }, { enabled: false, api_key: 'k' }]) {
    const m = mgr();
    m.cfg.failover = fo;
    const j = { id: 'j_x', state: 'running', project: 'p', depends_on: null };
    m.jobs.set(j.id, j);
    m.finish(j, 'failed', 'hit your session limit');
    assert.equal(j.state, 'failed', JSON.stringify(fo));
  }
});

test('activeIn finds concurrent work on a project, ignoring finished and self', () => {
  const m = mgr();
  m.jobs.set('j_a', job('j_a', 'running', { project: 'bnd-flux' }));
  m.jobs.set('j_b', job('j_b', 'queued', { project: 'bnd-flux' }));
  m.jobs.set('j_c', job('j_c', 'completed', { project: 'bnd-flux' }));
  m.jobs.set('j_d', job('j_d', 'running', { project: 'bnd-playbook' }));
  assert.equal(m.activeIn('bnd-flux').length, 2, 'running + queued only');
  assert.equal(m.activeIn('bnd-flux', 'j_a').length, 1, 'excludes itself');
  assert.equal(m.activeIn('bnd-playbook').length, 1);
  assert.equal(m.activeIn('nothing-here').length, 0);
});

test('a job killed with an empty result salvages its work from the stream', () => {
  const m = mgr();
  const jid = 'j_sal';
  fs.mkdirSync(path.join(m.jobsDir, jid), { recursive: true });
  const ev = blocks => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  fs.writeFileSync(path.join(m.jobsDir, jid, 'stream.jsonl'), [
    ev([{ type: 'thinking', thinking: 'internal working' }]),
    ev([{ type: 'text', text: 'Established: the matcher excludes page routes.' }]),
    '{ not json',
  ].join('\n'));

  const out = m.salvagePartial({ id: jid });
  assert.match(out, /^\[PARTIAL/);
  assert.match(out, /matcher excludes page routes/);
  assert.doesNotMatch(out, /internal working/, 'thinking is the model working, not a finding');

  // The cost-ceiling shape: result_text is the JSON-encoded empty string.
  const j = { id: jid, state: 'running', project: 'p', depends_on: null, notes: [], result_text: '""' };
  m.jobs.set(jid, j);
  m.finish(j, 'failed', 'cost ceiling of $20 reached');
  assert.match(j.result_text, /matcher excludes page routes/, 'salvage fired despite a truthy result_text');
  assert.ok(j.notes.some(n => /recovered from the stream/.test(n)));
});

test('a completed job is never overwritten by salvage', () => {
  const m = mgr();
  const j = { id: 'j_ok', state: 'running', project: 'p', depends_on: null, notes: [], result_text: 'the real answer' };
  m.jobs.set(j.id, j);
  m.finish(j, 'completed');
  assert.equal(j.result_text, 'the real answer');
});
