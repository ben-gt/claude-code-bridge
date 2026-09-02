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
