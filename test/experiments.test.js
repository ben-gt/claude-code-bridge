// Experiments: the bridge, not the agent, decides what is kept. These run the real loop against a real
// git repository and real measure commands; only the agent's turn is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobManager } from '../src/jobs.js';
import { DEFAULTS } from '../src/config.js';
import { parseMetric, normaliseSpec, isBetter, describeChange, inScope, median } from '../src/experiments.js';

const BRANCH = 'testing/passkeys';
const MEASURE = 'if [ -e src/slow ]; then sleep 30; fi; echo "noise 3"; echo "metric: $(cat src/value.txt)"';

function fixture(t, { remote = false, demo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-exp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', BRANCH);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'src/value.txt'), '10\n');
  fs.writeFileSync(path.join(repo, 'bench.sh'), 'echo "metric: $(cat src/value.txt)"\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  let origin = null;
  if (remote) {
    origin = path.join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', BRANCH, origin]);
    git('remote', 'add', 'origin', origin); git('push', '-qu', 'origin', BRANCH);
  }
  const cfg = { ...structuredClone(DEFAULTS), workspace_root: root, data_dir: path.join(root, '.jobs'), execution_branch: demo ? BRANCH : undefined };
  cfg.models.tiers.default.max_cost_usd = 10;
  const m = new JobManager(cfg, {}, { log: { info() {}, error() {}, warn() {} } });
  m.pump = () => {};
  t.after(() => { for (const timer of m.writeTimers.values()) clearTimeout(timer); });
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), content); };
  const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
  const originHead = () => execFileSync('git', ['--git-dir', origin, 'rev-parse', BRANCH], { encoding: 'utf8' }).trim();
  return { m, cfg, git, repo, root, write, read, originHead, origin };
}

const spec = extra => ({ project: 'app', objective: 'Make the value smaller', measure_command: MEASURE, direction: 'minimize', editable: ['src'], ...extra });

/**
 * Run an experiment whose agent turns are the given functions, in order. Each may edit the repository and
 * returns the agent's last message. Records the arguments every turn was launched with.
 */
async function experiment(f, args, turns) {
  const calls = [];
  let spent = 0;
  f.m.spawnClaude = async (job, cliArgs, opts) => {
    const n = calls.length;
    calls.push({ args: cliArgs, opts, prompt: cliArgs[cliArgs.indexOf('-p') + 1] });
    f.m.handleEvent(job, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-opus-5' }));
    const turn = turns[n];
    if (!turn) throw new Error(`no scripted turn ${n + 1}`);
    const out = await turn(job);
    if (out && typeof out === 'object') return out; // a turn that ended abnormally
    spent += 0.5;
    f.m.handleEvent(job, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: out }] } }));
    f.m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: spent, result: out }));
    return { code: 0 };
  };
  const { job_id } = await f.m.startExperiment(args);
  const j = f.m.get(job_id);
  j.state = 'running'; j.started_at = new Date().toISOString();
  await f.m.runExperimentJob(j);
  return { j, calls };
}

test('the metric is read from a named line, with a bare last number as the fallback', () => {
  assert.equal(parseMetric('building\nmetric: 12.5\ndone'), 12.5);
  assert.equal(parseMetric('metric: 3\nmetric: 4'), 4);
  assert.equal(parseMetric('p95_ms = 81.25 ms', 'p95_ms'), 81.25);
  assert.equal(parseMetric('Score: 1e-3', 'score'), 0.001);
  assert.equal(parseMetric('some output\n  42  \n'), 42);
  assert.equal(parseMetric('metric: fast'), null);
  assert.equal(parseMetric('took 12 seconds'), null);
  assert.equal(parseMetric(''), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(isBetter(9, 10, 'minimize'), true);
  assert.equal(isBetter(10, 10, 'minimize'), false);
  assert.equal(isBetter(9.8, 10, 'minimize', 0.5), false);
  assert.equal(isBetter(11, 10, 'maximize'), true);
  assert.equal(inScope('src/lib/a.js', ['src']), true);
  assert.equal(inScope('src2/a.js', ['src']), false);
  assert.equal(describeChange('I looked around.\n\nCHANGE: cache the lookup so it runs once'), 'cache the lookup so it runs once');
  assert.equal(describeChange('**DONE:** nothing left to try'), 'nothing left to try');
});

test('a request is refused unless it names a metric, a direction and a narrow place to change', t => {
  const f = fixture(t);
  const ok = spec();
  const refuse = (extra, why) => assert.throws(() => normaliseSpec(f.cfg, { ...ok, ...extra }, f.repo), why);
  assert.deepEqual(normaliseSpec(f.cfg, { ...ok, editable: ['./src/', 'src'] }, f.repo).editable, ['src']);
  refuse({ objective: ' ' }, /objective is required/);
  refuse({ direction: 'down' }, /minimize.*maximize/);
  refuse({ measure_command: '' }, /measure_command is required/);
  refuse({ editable: [] }, /editable is required/);
  refuse({ editable: ['.'] }, /whole repository/);
  refuse({ editable: ['../other'] }, /invalid editable/);
  refuse({ editable: ['/etc'] }, /invalid editable/);
  refuse({ editable: ['src/*.js'] }, /without wildcards/);
  refuse({ editable: ['nowhere'] }, /not found in the repository: nowhere/);
  refuse({ max_iterations: 31 }, /max_iterations/);
  refuse({ measure_runs: 9 }, /measure_runs/);
  refuse({ min_improvement: -1 }, /negative/);
  refuse({ measure_command: 'x'.repeat(2001) }, /too long/);
});

test('improvements are kept as commits, everything else is reverted, and the checkout is put back', async t => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  const { j, calls } = await experiment(f, spec({ max_iterations: 3 }), [
    () => { f.write('src/value.txt', '8\n'); return 'Looked at bench.\nCHANGE: lower the value to 8'; },
    () => { f.write('src/value.txt', '9\n'); return 'CHANGE: try 9'; },
    () => { f.write('src/value.txt', '5\n'); f.write('src/new.txt', 'helper\n'); return 'CHANGE: 5 with a helper'; },
  ]);
  assert.equal(j.state, 'completed');
  const x = j.experiment;
  assert.deepEqual(x.attempts.map(a => [a.n, a.status, a.metric]), [[1, 'keep', 8], [2, 'discard', 9], [3, 'keep', 5]]);
  assert.equal(x.baseline, 10); assert.equal(x.best, 5); assert.equal(x.kept, 2); assert.equal(x.best_attempt, 3);
  assert.match(x.stop_reason, /all 3 attempts/);
  // The checkout is back where it started, untouched; the kept work is on the experiment branch only.
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.equal(f.git('rev-parse', 'HEAD'), base);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.read('src/value.txt'), '10\n');
  assert.match(j.branch, /^experiment\/make-the-value-smaller-/);
  assert.equal(f.git('rev-list', '--count', `${base}..${j.branch}`), '2');
  assert.equal(f.git('show', `${j.branch}:src/value.txt`), '5');
  assert.equal(f.git('show', `${j.branch}:src/new.txt`), 'helper');
  assert.match(f.git('log', '-1', '--format=%s', j.branch), /^experiment: 5 with a helper$/);
  assert.equal(x.attempts[2].commit, f.git('rev-parse', '--short=8', j.branch));
  // Each turn after the first resumes the same session and is told what happened to the last one.
  assert.ok(!calls[0].args.includes('--resume'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'session-1');
  assert.match(calls[0].prompt, /baseline is metric = 10/);
  assert.match(calls[1].prompt, /Attempt 1 was kept: metric = 8/);
  assert.match(calls[2].prompt, /Attempt 2 was discarded and reverted: metric was 9/);
  assert.match(calls[2].prompt, /Best so far: metric = 8 \(baseline 10\)\. 1 attempt left/);
  const system = calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1];
  assert.match(system, /You may change only these paths: src\./);
  assert.match(system, /do not commit, stash, reset, switch branches or push/);
  // No attempt may take the whole budget.
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '4');
  assert.equal(j.cost_usd, 1.5);
  assert.deepEqual(x.attempts.map(a => a.cost_usd), [0.5, 0.5, 0.5]);
  assert.match(j.result_text, /Baseline 10 → best 5 \(−50\.0%\) after 3 attempts: 2 kept, 1 discarded\./);
  assert.match(j.result_text, /apply_experiment with job_id j_\w+ puts them on testing\/passkeys and pushes/);
  const rows = fs.readFileSync(path.join(f.m.jobDir(j.id), 'results.tsv'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 5);
  assert.match(rows[2], /^1\t[0-9a-f]{8}\t8\tkeep\tlower the value to 8$/);
  // A status caller gets every attempt and the report.
  const status = f.m.status(j.id);
  assert.equal(status.kind, 'experiment');
  assert.equal(status.experiment.attempts.length, 3);
  assert.equal(status.result, j.result_text);
  assert.equal(status.next_step, undefined);
});

test('a change outside the editable paths is discarded whole, however good the number', async t => {
  const f = fixture(t);
  const { j } = await experiment(f, spec({ measure_command: 'sh bench.sh', max_iterations: 2, patience: 2 }), [
    () => { f.write('bench.sh', 'echo "metric: 0"\n'); f.write('src/value.txt', '9\n'); return 'CHANGE: fix the benchmark'; },
    () => { f.write('src/value.txt', '9\n'); return 'CHANGE: an honest 9'; },
  ]);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['out_of_scope', 'keep']);
  assert.match(j.experiment.attempts[0].detail, /outside the editable paths: bench\.sh/);
  assert.equal(j.experiment.attempts[0].metric, null);
  assert.equal(f.git('show', `${j.branch}:bench.sh`), 'echo "metric: $(cat src/value.txt)"');
  assert.equal(j.experiment.best, 9);
});

test('a change that fails the check is not kept, and neither is one that breaks the measurement', async t => {
  const f = fixture(t);
  const { j, calls } = await experiment(f, spec({ check_command: 'test ! -e src/broken', max_iterations: 3 }), [
    () => { f.write('src/value.txt', '1\n'); f.write('src/broken', ''); return 'CHANGE: fast but broken'; },
    () => { f.write('src/value.txt', 'oops\n'); return 'CHANGE: not a number'; },
    () => { f.write('src/value.txt', '7\n'); return 'CHANGE: 7'; },
  ]);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['check_failed', 'crash', 'keep']);
  assert.match(j.experiment.attempts[0].detail, /check command exited with code 1/);
  assert.match(j.experiment.attempts[1].detail, /printed no "metric: <number>" line/);
  assert.match(calls[1].prompt, /Attempt 1 was discarded and reverted: the check command exited with code 1/);
  assert.equal(j.experiment.best, 7);
  assert.equal(f.git('rev-list', '--count', `${j.experiment.base_sha}..${j.branch}`), '1');
  assert.throws(() => f.git('show', `${j.branch}:src/broken`));
});

test('what the agent does with git does not change what is measured or what is published', async t => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  const { j } = await experiment(f, spec({ max_iterations: 3 }), [
    // Commits its own change: still one bridge commit, measured as usual.
    () => { f.write('src/value.txt', '8\n'); f.git('commit', '-qam', 'agent commit'); return 'CHANGE: committed it myself'; },
    // Leaves the experiment branch and commits on the branch other jobs publish.
    () => { f.git('checkout', '-q', BRANCH); f.write('src/value.txt', '1\n'); f.git('commit', '-qam', 'sneaky'); return 'CHANGE: on the wrong branch'; },
    // Writes an ignored file and an untracked one next to a real change.
    () => { f.write('cache/x', 'tmp'); f.write('src/value.txt', '6\n'); return 'CHANGE: 6'; },
  ]);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['keep', 'rule_break', 'keep']);
  assert.equal(f.git('rev-parse', BRANCH), base, 'the base branch is exactly where it was');
  assert.equal(f.git('rev-parse', 'HEAD'), base);
  assert.deepEqual(f.git('log', '--format=%s', `${base}..${j.branch}`).split('\n'), ['experiment: 6', 'experiment: committed it myself']);
  assert.equal(f.git('show', `${j.branch}:src/value.txt`), '6');
});

test('a lock file an install rewrote is left out of the attempt instead of sinking it', async t => {
  const f = fixture(t);
  f.write('package.json', '{"name":"app"}\n'); f.write('package-lock.json', '{"lockfileVersion":3}\n');
  f.git('add', '.'); f.git('commit', '-qm', 'manifest');
  const { j } = await experiment(f, spec({ max_iterations: 1, setup_command: 'echo "{}" > package-lock.json' }), [
    () => { f.write('package-lock.json', '{"churn":true}\n'); f.write('src/value.txt', '8\n'); return 'CHANGE: 8, after an install'; },
  ]);
  assert.equal(j.state, 'completed');
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['keep']);
  assert.equal(f.git('show', '--name-only', '--format=', j.branch), 'src/value.txt');
  assert.equal(f.read('package-lock.json'), '{"lockfileVersion":3}\n');
});

test('it stops when the agent has nothing left to try, or after too many attempts without a gain', async t => {
  const f = fixture(t);
  const done = await experiment(f, spec({ max_iterations: 6 }), [
    () => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; },
    () => 'Nothing else in src affects the number.\nDONE: the remaining cost is outside the editable paths',
  ]);
  assert.equal(done.j.state, 'completed');
  assert.deepEqual(done.j.experiment.attempts.map(a => a.status), ['keep', 'done']);
  assert.match(done.j.experiment.stop_reason, /no further change worth measuring \(the remaining cost is outside the editable paths\)/);

  const g = fixture(t);
  const stuck = await experiment(g, spec({ max_iterations: 6, patience: 2 }), [
    () => { g.write('src/value.txt', '12\n'); return 'CHANGE: 12'; },
    () => 'I am still reading.',
  ]);
  assert.deepEqual(stuck.j.experiment.attempts.map(a => a.status), ['discard', 'no_change']);
  assert.match(stuck.j.experiment.stop_reason, /no improvement in 2 consecutive attempts/);
  assert.equal(stuck.j.branch, null, 'a branch that kept nothing is removed');
  assert.equal(g.git('branch', '--list', 'experiment/*'), '');
  assert.match(stuck.j.result_text, /Baseline 10; no attempt improved it \(2 attempts: 1 discarded, 1 no change\)/);
  assert.match(stuck.j.result_text, /Nothing was kept, so the repository is exactly as it was/);
});

test('the target ends the experiment, and a margin keeps noise from counting as a gain', async t => {
  const f = fixture(t);
  const { j } = await experiment(f, spec({ max_iterations: 5, target: 7, min_improvement: 1 }), [
    () => { f.write('src/value.txt', '9.5\n'); return 'CHANGE: 9.5'; },
    () => { f.write('src/value.txt', '7\n'); return 'CHANGE: 7'; },
  ]);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['discard', 'keep']);
  assert.match(j.experiment.stop_reason, /target of 7 was reached/);
});

test('a baseline that cannot be measured fails the job before any agent turn, and nothing is left behind', async t => {
  const f = fixture(t);
  const { j, calls } = await experiment(f, spec({ measure_command: 'echo "no number here"' }), []);
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'baseline_failed');
  assert.match(j.error, /printed no "metric: <number>" line/);
  assert.equal(calls.length, 0);
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.equal(f.git('branch', '--list', 'experiment/*'), '');

  const g = fixture(t);
  const failing = await experiment(g, spec({ check_command: 'false' }), []);
  assert.equal(failing.j.error_code, 'baseline_check_failed');
  const h = fixture(t);
  const setup = await experiment(h, spec({ setup_command: 'echo stray > stray.txt' }), []);
  assert.equal(setup.j.error_code, 'setup_failed');
  assert.match(setup.j.error, /left uncommitted changes/);
  assert.equal(h.git('status', '--porcelain'), '');
});

test('a turn stopped at its budget or time limit is discarded and the next one carries on', async t => {
  const f = fixture(t);
  const { j, calls } = await experiment(f, spec({ max_iterations: 3 }), [
    job => { f.write('src/value.txt', '2\n'); f.m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 4, errors: ['Reached maximum budget'] })); return { code: 1 }; },
    () => { f.write('src/value.txt', '3\n'); return { code: null, timedOut: true }; },
    () => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; },
  ]);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['budget', 'timeout', 'keep']);
  assert.match(calls[1].prompt, /stopped at the budget for one turn and reverted/);
  assert.equal(j.experiment.best, 8);
  assert.equal(j.state, 'completed');
});

test('an agent session that fails outright ends the experiment as a failure', async t => {
  const f = fixture(t);
  const { j } = await experiment(f, spec(), [
    job => { f.m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, result: 'API Error: 500' })); return { code: 1 }; },
  ]);
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'agent_failed');
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
});

test('cancelling drops the attempt in progress and keeps what was already kept', async t => {
  const f = fixture(t);
  let cancel;
  const { j } = await experiment(f, spec({ max_iterations: 4 }), [
    () => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; },
    job => {
      // The measurement of this attempt sleeps; cancel while it runs.
      f.write('src/value.txt', '4\n'); f.write('src/slow', '');
      const wait = setInterval(() => { if (/measuring/.test(job.activity)) { clearInterval(wait); cancel = f.m.cancel(job.id); } }, 50);
      return 'CHANGE: 4, slowly';
    },
  ]);
  const answer = await cancel;
  assert.equal(j.state, 'cancelled');
  assert.equal(answer.state, 'cancelled');
  assert.match(answer.cleanup[0], /1 kept commit\(s\) remain on experiment\//);
  assert.deepEqual(j.experiment.attempts.map(a => a.status), ['keep']);
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('show', `${j.branch}:src/value.txt`), '8');
  assert.match(j.result_text, /Stopped: cancelled by request/);
});

test('apply fast-forwards an unmoved branch and pushes it', async t => {
  const f = fixture(t, { remote: true });
  const { j } = await experiment(f, spec({ max_iterations: 1 }), [() => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; }]);
  assert.equal(j.pushed, false);
  const before = f.originHead();
  const r = await f.m.applyExperiment({ job_id: j.id });
  assert.equal(r.method, 'fast-forward');
  assert.equal(r.pushed, true);
  assert.notEqual(f.originHead(), before);
  assert.equal(f.originHead(), f.git('rev-parse', j.branch));
  assert.equal(f.git('rev-parse', 'HEAD'), f.originHead());
  assert.equal(f.read('src/value.txt'), '8\n');
  assert.match(f.m.status(j.id).result, /Applied .*1 commit put on testing\/passkeys by fast-forward and pushed/);
  await assert.rejects(f.m.applyExperiment({ job_id: j.id }), /already applied/);
});

test('apply cherry-picks onto a branch that has moved and says the metric was not re-measured', async t => {
  const f = fixture(t, { remote: true });
  const { j } = await experiment(f, spec({ max_iterations: 1 }), [() => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; }]);
  f.write('other.txt', 'someone else\n'); f.git('add', '.'); f.git('commit', '-qm', 'unrelated'); f.git('push', '-q', 'origin', BRANCH);
  const r = await f.m.applyExperiment({ job_id: j.id });
  assert.equal(r.method, 'cherry-pick');
  assert.match(r.summary, /had moved since the experiment, so the measured metric = 8 was not re-measured/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.originHead());
  assert.equal(f.read('src/value.txt'), '8\n');
  assert.equal(f.read('other.txt'), 'someone else\n');
});

test('apply that conflicts changes nothing, and there is nothing to apply when nothing was kept', async t => {
  const f = fixture(t, { remote: true });
  const { j } = await experiment(f, spec({ max_iterations: 1 }), [() => { f.write('src/value.txt', '8\n'); return 'CHANGE: 8'; }]);
  f.write('src/value.txt', '11\n'); f.git('commit', '-qam', 'conflicting'); f.git('push', '-q', 'origin', BRANCH);
  const head = f.git('rev-parse', 'HEAD');
  await assert.rejects(f.m.applyExperiment({ job_id: j.id }), /no longer apply cleanly \(conflicts: src\/value\.txt\)/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.originHead(), head);
  assert.equal(j.experiment.applied, null);

  const g = fixture(t);
  const none = await experiment(g, spec({ max_iterations: 1 }), [() => 'DONE: nothing to do']);
  await assert.rejects(g.m.applyExperiment({ job_id: none.j.id }), /kept no changes/);
});

test('an experiment waits in its own lane and holds its project', async t => {
  const f = fixture(t);
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  for (const a of [['init', '-q', '-b', BRANCH], ['config', 'user.name', 'T'], ['config', 'user.email', 't@example.invalid'], ['commit', '-q', '--allow-empty', '-m', 'initial']]) execFileSync('git', a, { cwd: other });
  f.cfg.limits.max_concurrent_jobs = 1;
  delete f.m.pump; // the real one
  const started = [];
  f.m.runExperimentJob = job => { started.push(job.id); return new Promise(() => {}); };
  f.m.runJob = job => { started.push(job.id); return new Promise(() => {}); };
  const exp = await f.m.startExperiment(spec());
  const second = await f.m.startExperiment({ ...spec(), project: 'other' }).catch(e => e);
  assert.match(second.message, /not found in the repository/); // "other" has no src: refused before queueing
  const task = await f.m.start({ project: 'other', prompt: 'Fix', mode: 'plan' });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.deepEqual(started.sort(), [exp.job_id, task.job_id].sort(), 'the ordinary job is not queued behind the experiment');
  assert.equal(f.m.get(exp.job_id).state, 'running');
  await assert.rejects(f.m.start({ project: 'app', prompt: 'Fix', mode: 'plan' }), /already has an active experiment job/);
  await assert.rejects(f.m.applyExperiment({ job_id: exp.job_id }), /still running/);
  await assert.rejects(f.m.continueJob({ job_id: exp.job_id }), /not a Claude Code job/);
});

test('an experiment cut off by a restart has its checkout put back at the next start', async t => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  const { job_id } = await f.m.startExperiment(spec());
  const j = f.m.get(job_id);
  // As a restart leaves it: on the experiment branch, one commit kept, a half-made candidate in the tree.
  f.git('checkout', '-q', '-b', 'experiment/cut-off');
  f.write('src/value.txt', '8\n'); f.git('commit', '-qam', 'experiment: 8');
  f.write('src/value.txt', '3\n'); f.write('src/half.txt', 'unfinished');
  Object.assign(j, { state: 'running', started_at: new Date().toISOString(), branch: 'experiment/cut-off', original_branch: BRANCH, original_sha: base });
  Object.assign(j.experiment, { base_sha: base, baseline: 10, best: 8, kept: 1, attempts: [{ n: 1, status: 'keep', metric: 8, commit: 'abcdef12', description: '8' }] });
  f.m.save(j, { immediate: true });

  const next = new JobManager(f.cfg, {}, { log: { info() {}, error() {}, warn() {} } });
  next.pump = () => {};
  next.init();
  const r = next.get(job_id);
  assert.equal(r.state, 'interrupted');
  for (let i = 0; i < 100 && !r.experiment.stop_reason; i++) await new Promise(res => setTimeout(res, 20));
  assert.match(r.experiment.stop_reason, /server restarted/);
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('show', 'experiment/cut-off:src/value.txt'), '8');
  assert.match(r.result_text, /1 kept commit is on local branch experiment\/cut-off/);
  for (const timer of next.writeTimers.values()) clearTimeout(timer);
});
