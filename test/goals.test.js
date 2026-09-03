import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoalManager } from '../src/goals.js';

const quiet = { info() {}, warn() {}, error() {} };
const mk = () => new GoalManager(
  { data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'goals-')), goals: { budget_usd: 25 } },
  { log: quiet },
);
const job = (o = {}) => ({ id: 'j_1', project: 'bnd-flux', state: 'completed', cost_usd: 0, ...o });

test('a goal starts with its objective on the blackboard and no findings', () => {
  const g = mk();
  const goal = g.create({ objective: 'passkeys on every portal' });
  assert.match(goal.id, /^g_/);
  assert.equal(goal.state, 'active');
  assert.equal(goal.budget_usd, 25);
  const bb = g.blackboard(goal.id);
  assert.match(bb, /passkeys on every portal/);
  assert.match(bb, /No findings recorded yet/);
});

test('objective is required and the budget must be positive', () => {
  const g = mk();
  assert.throws(() => g.create({ objective: '   ' }), /objective is required/);
  assert.throws(() => g.create({ objective: 'x', budget_usd: 0 }), /positive/);
  assert.throws(() => g.get('g_nope'), /not a known goal/);
});

test('findings accumulate in order and replace the empty-state line', () => {
  const g = mk();
  const goal = g.create({ objective: 'o' });
  g.appendFinding(goal.id, { job: job({ id: 'j_a', project: 'bnd-submissions' }), text: 'token scope is sufficient' });
  g.appendFinding(goal.id, { job: job({ id: 'j_b', project: 'bnd-flux', branch: 'bridge/x' }), text: 'image rebuilt' });
  const bb = g.blackboard(goal.id);
  assert.doesNotMatch(bb, /No findings recorded yet/);
  assert.ok(bb.indexOf('token scope is sufficient') < bb.indexOf('image rebuilt'), 'order preserved');
  assert.match(bb, /bnd-submissions — completed \(j_a\)/);
  assert.match(bb, /branch `bridge\/x`/);
});

test('a failed child still records a finding', () => {
  const g = mk();
  const goal = g.create({ objective: 'o' });
  g.appendFinding(goal.id, { job: job({ state: 'failed' }), text: 'no .env present' });
  assert.match(g.blackboard(goal.id), /failed \(j_1\)[\s\S]*no \.env present/);
});

test('spend is summed across children and the budget gates dispatch before spending', () => {
  const g = mk();
  const goal = g.create({ objective: 'o', budget_usd: 10 });
  const jobsById = new Map();
  for (const [id, cost] of [['j_a', 4], ['j_b', 3.5]]) {
    jobsById.set(id, job({ id, cost_usd: cost }));
    g.attach(goal.id, id);
  }
  assert.equal(g.spent(goal.id, jobsById), 7.5);
  const ok = g.canDispatch(goal.id, jobsById);
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 2.5);

  jobsById.set('j_c', job({ id: 'j_c', cost_usd: 6 }));
  g.attach(goal.id, 'j_c');
  const blocked = g.canDispatch(goal.id, jobsById);
  assert.equal(blocked.ok, false);
  assert.match(blocked.why, /budget spent/);
  assert.equal(g.get(goal.id).state, 'exhausted', 'goal closes itself when the money runs out');
});

test('attach is idempotent and settle waits for every child to end', () => {
  const g = mk();
  const goal = g.create({ objective: 'o' });
  g.attach(goal.id, 'j_a'); g.attach(goal.id, 'j_a');
  g.attach(goal.id, 'j_b');
  assert.deepEqual(g.get(goal.id).job_ids, ['j_a', 'j_b']);

  const jobsById = new Map([
    ['j_a', job({ id: 'j_a' })],
    ['j_b', job({ id: 'j_b', state: 'running' })],
  ]);
  g.settle(goal.id, jobsById);
  assert.equal(g.get(goal.id).state, 'active', 'still running -> stays active');

  jobsById.get('j_b').state = 'failed';
  g.settle(goal.id, jobsById);
  assert.equal(g.get(goal.id).state, 'completed', 'a failed child still ends the goal');
});

test('cancel blocks further dispatch, and status reports the board', () => {
  const g = mk();
  const goal = g.create({ objective: 'ship it' });
  g.attach(goal.id, 'j_a');
  const jobsById = new Map([['j_a', job({ id: 'j_a', cost_usd: 1.25, model_selected: 'claude-opus-5' })]]);
  const st = g.status(goal.id, jobsById);
  assert.equal(st.objective, 'ship it');
  assert.equal(st.counts.completed, 1);
  assert.equal(st.spent_usd, 1.25);
  assert.equal(st.jobs[0].model, 'claude-opus-5');

  g.cancel(goal.id);
  assert.equal(g.canDispatch(goal.id, jobsById).ok, false);
});

test('goals survive a restart', () => {
  const g = mk();
  const goal = g.create({ objective: 'persisted' });
  g.appendFinding(goal.id, { job: job(), text: 'a finding' });
  const again = new GoalManager({ data_dir: g.dir.replace(/\/goals$/, ''), goals: {} }, { log: quiet });
  again.init();
  assert.equal(again.get(goal.id).objective, 'persisted');
  assert.match(again.blackboard(goal.id), /a finding/);
});

test('the board keeps the NEWEST findings when it overflows', () => {
  const g = mk();
  const goal = g.create({ objective: 'keep the newest' });
  for (let i = 1; i <= 40; i++) {
    g.appendFinding(goal.id, { job: job({ id: `j_${i}`, project: `proj-${i}` }), text: `finding ${i} `.repeat(60) });
  }
  const bb = g.blackboard(goal.id, { max: 4000 });
  assert.ok(bb.length <= 4200, 'respects the cap');
  assert.match(bb, /keep the newest/, 'objective survives');
  assert.match(bb, /proj-40/, 'newest finding survives');
  assert.doesNotMatch(bb, /proj-1 —/, 'oldest is the one dropped');
  assert.match(bb, /earlier findings trimmed/);
});

test('harness apologies never reach the board', () => {
  const g = mk();
  const goal = g.create({ objective: 'o' });
  g.appendFinding(goal.id, { job: job(), text:
    'The Write tool is not available in this session, so the plan file cannot be created.\nThe real finding is here.' });
  const bb = g.blackboard(goal.id);
  assert.doesNotMatch(bb, /Write tool is not available/);
  assert.match(bb, /The real finding is here/);
});

test('a supervised goal holds its changes and waits rather than completing', () => {
  const g = mk();
  const goal = g.create({
    objective: 'Roll passkeys out',
    supervise: true,
    pending: [{ project: 'bnd-flux', prompt: 'do it', mode: 'execute' }],
  });
  g.attach(goal.id, 'j_a');
  const jobs = new Map([['j_a', job({ id: 'j_a' })]]);

  assert.equal(g.settle(goal.id, jobs), 'awaiting_approval');
  assert.equal(g.get(goal.id).state, 'awaiting_approval', 'not completed — waiting on a person');

  const released = g.releasePending(goal.id);
  assert.equal(released.length, 1);
  assert.equal(g.get(goal.id).state, 'active');
  assert.deepEqual(g.get(goal.id).pending_jobs, [], 'released once only');
  // With nothing held, the goal is free to finish.
  assert.equal(g.settle(goal.id, jobs), undefined);
  assert.equal(g.get(goal.id).state, 'completed');
});

test('declining discards the held work instead of running it', () => {
  const g = mk();
  const goal = g.create({ objective: 'o', supervise: true, pending: [{ project: 'p' }, { project: 'q' }] });
  assert.equal(g.discardPending(goal.id, 'timed_out'), 2);
  assert.equal(g.get(goal.id).state, 'cancelled');
  assert.deepEqual(g.get(goal.id).pending_jobs, []);
});

test('an unsupervised goal is unaffected', () => {
  const g = mk();
  const goal = g.create({ objective: 'o' });
  g.attach(goal.id, 'j_a');
  assert.equal(g.settle(goal.id, new Map([['j_a', job({ id: 'j_a' })]])), undefined);
  assert.equal(g.get(goal.id).state, 'completed');
});
