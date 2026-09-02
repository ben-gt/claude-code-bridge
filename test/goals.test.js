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
