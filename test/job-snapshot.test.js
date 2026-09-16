import test from 'node:test';
import assert from 'node:assert/strict';
import { jobSnapshot } from '../src/job-snapshot.js';
test('counts all records, including active jobs outside the latest fifty', () => {
  const records = Array.from({ length: 123 }, (_, i) => ({ id: String(i), created_at: new Date(i * 1000).toISOString(), state: i < 3 ? 'running' : i < 10 ? 'queued' : 'completed' }));
  const result = jobSnapshot(records);
  assert.equal(result.counts.total, 123);
  assert.equal(result.counts.running, 3);
  assert.equal(result.counts.queued, 7);
  assert.equal(result.counts.completed, 113);
  assert.equal(result.jobs.length, 60);
  assert.equal(result.jobs.filter(j => j.state === 'running').length, 3);
  assert.equal(result.jobs.filter(j => j.state === 'queued').length, 7);
});
test('row limits never cap exact counts; state transitions update counts and rows together', () => {
  const records = Array.from({ length: 301 }, (_, i) => ({ id: String(i), created_at: new Date(i * 1000).toISOString(), state: 'queued' }));
  let result = jobSnapshot(records);
  assert.equal(result.counts.queued, 301);
  assert.equal(result.active_limited, true);
  records[300].state = 'running'; records[299].state = 'failed';
  result = jobSnapshot(records);
  assert.equal(result.counts.queued, 299);
  assert.equal(result.counts.running, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.jobs.find(j => j.job_id === '300').state, 'running');
  assert.equal(jobSnapshot([]).counts.total, 0);
});
