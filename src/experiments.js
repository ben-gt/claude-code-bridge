// Experiment jobs: a measured optimisation loop, after karpathy/autoresearch.
//
// The agent proposes one change per turn. The bridge, not the agent, owns everything that decides
// the outcome: it commits the change, runs the fixed measurement, keeps the commit when the metric
// improved and reverts it otherwise, then tells the agent what happened and asks for the next one.
// Kept commits collect on a local experiment branch; nothing is pushed until apply_experiment.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git, run, currentBranchFast, workingTreeStatus, hasRemote, branchExists, defaultBranch, reconcileBranch, GitError } from './git.js';
import { projectOverrides } from './config.js';
import { scrub } from './scrub.js';

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const OUTPUT_CAP = 200_000;
const COMMAND_MAX = 2000;

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const round4 = n => Math.round(n * 10000) / 10000;
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Short, stable rendering of a metric value. */
export const fmt = v => (typeof v === 'number' && Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '—');

/** Limits and defaults, from config with fallbacks so an older config file still works. */
export function experimentOptions(cfg) {
  const e = cfg.experiments || {};
  return {
    max_concurrent: e.max_concurrent ?? 1,
    default_iterations: e.default_iterations ?? 6,
    max_iterations: e.max_iterations ?? 30,
    default_patience: e.default_patience ?? 3,
    timeout_minutes: e.timeout_minutes ?? 90,
    max_timeout_minutes: e.max_timeout_minutes ?? 480,
    attempt_minutes: e.attempt_minutes ?? 15,
    // No single attempt may spend more than this share of the job's ceiling, so one runaway turn cannot be the whole experiment.
    attempt_cost_share: e.attempt_cost_share ?? 0.4,
    measure_timeout_seconds: e.measure_timeout_seconds ?? 300,
    max_measure_timeout_seconds: e.max_measure_timeout_seconds ?? 1800,
    setup_timeout_seconds: e.setup_timeout_seconds ?? 900,
    max_cost_usd: e.max_cost_usd ?? null,
    branch_prefix: e.branch_prefix || 'experiment/',
  };
}

// ---------- pure helpers (unit-tested) ----------

/**
 * The metric a measurement printed: the last "<name>: <number>" (or "<name>=<number>") line of its
 * output, a unit allowed after the number; failing that, a bare number on the last non-empty line.
 */
export function parseMetric(stdout, name = 'metric') {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const named = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:=]\\s*(${NUM})\\s*[A-Za-z%/]*\\s*$`, 'i');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(named);
    if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
  }
  const last = lines.map(l => l.trim()).filter(Boolean).pop();
  if (last && new RegExp(`^${NUM}$`).test(last) && Number.isFinite(Number(last))) return Number(last);
  return null;
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Is `value` better than `best` by more than `margin`, in the experiment's direction? */
export function isBetter(value, best, direction, margin = 0) {
  return direction === 'maximize' ? value > best + margin : value < best - margin;
}

export function targetReached(value, target, direction) {
  if (typeof target !== 'number') return false;
  return direction === 'maximize' ? value >= target : value <= target;
}

/** A repository-relative file or directory the agent may change. */
function normalisePath(p) {
  if (typeof p !== 'string') throw new Error('editable entries must be strings');
  let s = p.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!s || s === '.') throw new Error('editable may not be the whole repository: name the files or directories the change may touch, so the measurement itself stays out of reach');
  if (s.length > 300 || s.startsWith('/') || s.startsWith('-') || s.includes('\\') || s.includes('\0') || /[*?\[\]{}]/.test(s)) throw new Error(`invalid editable path "${trunc(p, 80)}": use a plain repository-relative file or directory, without wildcards`);
  const parts = s.split('/');
  if (parts.some(x => x === '..' || x === '.' || x === '' || x === '.git')) throw new Error(`invalid editable path "${trunc(p, 80)}"`);
  return s;
}

export function inScope(file, editable) {
  return editable.some(e => file === e || file.startsWith(`${e}/`));
}

function command(value, label, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a shell command`);
  if (value.length > COMMAND_MAX || value.includes('\0')) throw new Error(`${label} is too long (max ${COMMAND_MAX} characters); put the logic in a script in the repository and call that`);
  return value.trim();
}

function integer(value, label, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

/** Validate a start_experiment request into the specification stored on the job. Throws with the reason. */
export function normaliseSpec(cfg, args, projectDir) {
  const o = experimentOptions(cfg);
  if (typeof args.objective !== 'string' || !args.objective.trim()) throw new Error('objective is required: say what should improve');
  if (args.objective.length > 4000) throw new Error('objective is too long (max 4000 characters)');
  if (!['minimize', 'maximize'].includes(args.direction)) throw new Error('direction must be "minimize" or "maximize"');
  const metric_name = args.metric_name === undefined || args.metric_name === null ? 'metric' : args.metric_name;
  if (typeof metric_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_. -]{0,39}$/.test(metric_name)) throw new Error('metric_name must be a short label (letters, digits, space, dot, dash, underscore)');
  if (!Array.isArray(args.editable) || !args.editable.length) throw new Error('editable is required: the files or directories the agent may change');
  if (args.editable.length > 20) throw new Error('editable takes at most 20 paths');
  const editable = [...new Set(args.editable.map(normalisePath))];
  if (projectDir) {
    const missing = editable.filter(e => !fs.existsSync(path.join(projectDir, e)));
    if (missing.length) throw new Error(`editable path${missing.length === 1 ? '' : 's'} not found in the repository: ${missing.join(', ')}`);
  }
  const number = (v, label) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} must be a number`);
    return v;
  };
  const min_improvement = number(args.min_improvement, 'min_improvement') ?? 0;
  if (min_improvement < 0) throw new Error('min_improvement cannot be negative');
  return {
    objective: args.objective.trim(),
    metric_name,
    direction: args.direction,
    measure_command: command(args.measure_command, 'measure_command', true),
    check_command: command(args.check_command, 'check_command', false),
    setup_command: command(args.setup_command, 'setup_command', false),
    editable,
    max_iterations: integer(args.max_iterations, 'max_iterations', { min: 1, max: o.max_iterations, fallback: Math.min(o.default_iterations, o.max_iterations) }),
    patience: integer(args.patience, 'patience', { min: 1, max: o.max_iterations, fallback: o.default_patience }),
    measure_runs: integer(args.measure_runs, 'measure_runs', { min: 1, max: 5, fallback: 1 }),
    measure_timeout_seconds: integer(args.measure_timeout_seconds, 'measure_timeout_seconds', { min: 5, max: o.max_measure_timeout_seconds, fallback: o.measure_timeout_seconds }),
    min_improvement,
    target: number(args.target, 'target'),
    base_sha: null, baseline: null, best: null, best_attempt: null, kept: 0, attempts: [], stop_reason: null, applied: null,
  };
}

/** What the agent said it changed: its CHANGE:/DONE: line, else the first line of its last message. */
export function describeChange(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^[*_`]*(?:CHANGE|DONE)[*_`]*\s*:[*_`]*\s*(.+)$/i);
    if (m) return trunc(oneLine(m[1].replace(/[*_`]+$/, '')), 220);
  }
  return trunc(oneLine(lines[0] || ''), 220);
}

const saidDone = text => /^[*_`]*DONE[*_`]*\s*:/im.test(String(text ?? ''));

const STATUS_LABEL = {
  keep: 'kept', discard: 'discarded', check_failed: 'failed check', crash: 'measurement failed', out_of_scope: 'out of scope',
  no_change: 'no change', done: 'no further idea', timeout: 'timed out', budget: 'over attempt budget', error: 'agent error', rule_break: 'left the branch',
};

/** Signed change from the baseline, as a percentage. */
function change(spec) {
  if (typeof spec.baseline !== 'number' || typeof spec.best !== 'number' || !spec.baseline) return null;
  const pct = ((spec.best - spec.baseline) / Math.abs(spec.baseline)) * 100;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`;
}

/** The report a requester reads: what was measured, what happened to each attempt, and where the kept work is. */
export function report(job, cfg = {}) {
  const x = job.experiment;
  const lines = [`Experiment on ${job.project}: ${trunc(oneLine(x.objective), 300)}`,
    `Metric "${x.metric_name}" (${x.direction === 'maximize' ? 'higher' : 'lower'} is better), measured by \`${trunc(x.measure_command, 200)}\`${x.measure_runs > 1 ? `, median of ${x.measure_runs} runs` : ''}.${x.check_command ? ` A change was kept only if \`${trunc(x.check_command, 200)}\` passed.` : ''}`];
  if (typeof x.baseline !== 'number') {
    lines.push('No baseline was measured, so no attempt was made.');
  } else {
    const counts = {};
    for (const a of x.attempts) counts[a.status] = (counts[a.status] || 0) + 1;
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${STATUS_LABEL[k] || k}`).join(', ');
    const delta = change(x);
    lines.push(x.kept
      ? `Baseline ${fmt(x.baseline)} → best ${fmt(x.best)}${delta ? ` (${delta})` : ''} after ${x.attempts.length} attempt${x.attempts.length === 1 ? '' : 's'}: ${tally}.`
      : `Baseline ${fmt(x.baseline)}; no attempt improved it${x.attempts.length ? ` (${x.attempts.length} attempt${x.attempts.length === 1 ? '' : 's'}: ${tally})` : ''}.`);
    if (x.stop_reason) lines.push(`Stopped: ${x.stop_reason}.`);
    lines.push('', `| # | result | ${x.metric_name} | change |`, '|---|---|---|---|', `| 0 | baseline | ${fmt(x.baseline)} | |`);
    for (const a of x.attempts) {
      const what = [a.description, a.detail ? `(${trunc(oneLine(a.detail), 160)})` : ''].filter(Boolean).join(' ');
      lines.push(`| ${a.n} | ${STATUS_LABEL[a.status] || a.status}${a.commit ? ` \`${a.commit}\`` : ''} | ${fmt(a.metric)} | ${trunc(what, 320).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    if (x.applied) {
      lines.push(`Applied ${x.applied.at}: ${x.applied.summary}`);
    } else if (x.kept && job.branch) {
      lines.push(`The ${x.kept} kept commit${x.kept === 1 ? ' is' : 's are'} on local branch ${job.branch} in the bridge checkout (base ${String(x.base_sha).slice(0, 8)}). Nothing was pushed or merged; apply_experiment with job_id ${job.id} ${cfg.execution_branch ? `puts them on ${cfg.execution_branch} and pushes` : 'pushes the branch and opens a draft PR'}.`);
    } else {
      lines.push('Nothing was kept, so the repository is exactly as it was.');
    }
  }
  const spent = typeof job.cost_usd === 'number' ? `$${job.cost_usd} of $${job.limits.max_cost_usd}` : `nothing recorded of $${job.limits.max_cost_usd}`;
  lines.push(`Spent ${spent}.`);
  return scrub(lines.join('\n'));
}

/** The experiment as a status caller sees it: a few numbers while it runs, the whole record afterwards. */
export function experimentView(x, { lean = false } = {}) {
  if (!x) return undefined;
  const head = { metric_name: x.metric_name, direction: x.direction, baseline: x.baseline, best: x.best, attempts_done: x.attempts.length, max_iterations: x.max_iterations, kept: x.kept };
  if (lean) return head;
  return {
    ...head, objective: trunc(x.objective, 600), measure_command: trunc(x.measure_command, 400), check_command: x.check_command ? trunc(x.check_command, 400) : undefined,
    editable: x.editable, base_sha: x.base_sha || undefined, best_attempt: x.best_attempt ?? undefined, stop_reason: x.stop_reason || undefined,
    attempts: x.attempts.map(a => ({ n: a.n, status: a.status, metric: a.metric ?? undefined, commit: a.commit || undefined, description: a.description || undefined, detail: a.detail ? trunc(a.detail, 300) : undefined, cost_usd: a.cost_usd ?? undefined })),
    applied: x.applied || undefined,
  };
}

// ---------- prompts ----------

function systemPrompt(m, job, attemptBudget) {
  const x = job.experiment, o = experimentOptions(m.cfg);
  const lines = [
    `You are running unattended through the Claude Code Bridge (job ${job.id}) in the repository "${job.project}" at ${job.project_path}, as the proposer in a measured optimisation experiment. Nobody can answer questions, so decide for yourself.`,
    `How it works: each turn you make ONE focused change meant to improve a metric and then stop. The bridge, not you, then commits the change, runs the fixed measurement, keeps the commit if the metric improved and reverts it if not, and tells you the outcome before asking for the next change.`,
    `Metric: "${x.metric_name}" — ${x.direction === 'maximize' ? 'higher' : 'lower'} is better${x.min_improvement ? `, and a change must beat the best so far by more than ${fmt(x.min_improvement)} to be kept` : ''}. The bridge measures it by running this from the repository root${x.measure_runs > 1 ? ` (median of ${x.measure_runs} runs)` : ''}: ${x.measure_command}`,
  ];
  if (x.check_command) lines.push(`A change is kept only if this also exits 0: ${x.check_command}`);
  lines.push(
    `You may change only these paths: ${x.editable.join(', ')}. A turn that changes anything else is discarded whole. Never move the number by editing the measurement, its inputs, fixtures, thresholds or tests: the aim is a real improvement, and a rigged one is worthless to the person who asked.`,
    `Git belongs to the bridge: do not commit, stash, reset, switch branches or push. Leave your change uncommitted in the working tree. You may read anything in the repository and run quick commands to understand the code, but the bridge runs the measurement, so do not spend your turn re-running it.`,
    `Each turn stops at about $${attemptBudget} of usage or ${o.attempt_minutes} minutes, and a turn stopped short is discarded. Keep each change small and independent so its effect can be attributed, and prefer simpler code: complexity for a marginal gain is not worth keeping.`,
    `Do everything in the foreground: never start background work, schedule a wake-up or wait on a notification. Stay inside this repository. Never print secrets, tokens or the contents of .env files.`,
    `End every turn with one final line: "CHANGE: <one sentence: what you changed and why it should help>". If you have no further idea worth measuring, change nothing and end with "DONE: <why>".`,
  );
  if (m.cfg.execution_branch) lines.push(`Demo server rules: stay in this isolated checkout and never alter the shared /srv app checkouts. Never run a Docker build. Tests use at most two workers.`);
  return lines.join('\n');
}

function firstPrompt(x) {
  return `Objective: ${x.objective}\n\nThe baseline is ${x.metric_name} = ${fmt(x.baseline)}. Read what you need to understand where that number comes from (start with the measurement command and the editable paths), then make your first change.`;
}

function feedbackPrompt(x, a, left) {
  const m = x.metric_name;
  const outcome = {
    keep: `kept: ${m} = ${fmt(a.metric)}, a new best`,
    discard: `discarded and reverted: ${m} was ${fmt(a.metric)}, not better than the best so far`,
    check_failed: `discarded and reverted: ${a.detail || 'the check command failed'}`,
    crash: `discarded and reverted: ${a.detail || 'the measurement failed'}`,
    out_of_scope: `discarded and reverted: ${a.detail || 'it changed files outside the editable paths'}`,
    rule_break: `discarded and reverted: ${a.detail || 'the checkout was moved off the experiment branch'}. Leave git to the bridge`,
    no_change: `not measured: the working tree was unchanged. Make a change, or end with "DONE: <why>"`,
    timeout: `stopped at the time limit for one turn and reverted. Make a smaller change`,
    budget: `stopped at the budget for one turn and reverted. Make a smaller change and read less`,
  }[a.status] || a.status;
  return `Attempt ${a.n} was ${outcome}.\nBest so far: ${m} = ${fmt(x.best)} (baseline ${fmt(x.baseline)}). ${left} attempt${left === 1 ? '' : 's'} left. The repository is at the best state so far. Make the next change, or end with "DONE: <why>" if nothing else is worth measuring.`;
}

// ---------- shell and git steps ----------

function shellEnv(job) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb',
    SHELL: process.env.SHELL || '/bin/bash', CI: '1', GIT_TERMINAL_PROMPT: '0', CLAUDE_CODE_BRIDGE_JOB: job.id,
  };
}

/** Run a shell command in the checkout as the job's current child, so cancel and the time limit can stop it. */
function runShell(m, job, cmd, { timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '', err = '', timedOut = false, settled = false, timer = null;
    const done = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (m.procs.get(job.id)?.child === child) m.procs.delete(job.id);
      job.pid = null;
      resolve({ code, timedOut, stdout: scrub(out), stderr: scrub(err), seconds: Math.round((Date.now() - started) / 1000) });
    };
    let child;
    try {
      child = spawn('bash', ['-c', cmd], { cwd: job.project_path, env: shellEnv(job), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      err = e.message;
      return done(-1);
    }
    timer = setTimeout(() => { timedOut = true; m.killTree(job); }, timeoutMs);
    m.procs.set(job.id, { child, timer });
    job.pid = child.pid;
    child.stdout.on('data', d => { out = (out + d).slice(-OUTPUT_CAP); });
    child.stderr.on('data', d => { err = (err + d).slice(-OUTPUT_CAP); });
    child.on('error', e => { err += e.message; done(-1); });
    child.on('close', code => done(code));
  });
}

const tail = (r, n = 600) => trunc(oneLine(`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join(' ⏎ ')), n) || '(no output)';

async function cleanTree(dir, to = 'HEAD') {
  await run('git', ['reset', '--hard', '--quiet', to], { cwd: dir, timeoutMs: 60_000 });
  await run('git', ['clean', '-fdq'], { cwd: dir, timeoutMs: 60_000 });
}

/**
 * Put the checkout back where the job found it and drop an experiment branch that kept nothing.
 * Safe to call more than once, and after a restart: it only touches a checkout still on the job's branch.
 */
export async function restoreCheckout(m, job) {
  const dir = job.project_path;
  if (!job.branch || !fs.existsSync(dir)) return;
  try {
    if (currentBranchFast(dir) === job.branch) {
      await cleanTree(dir);
      const back = job.original_branch ? ['checkout', '--quiet', job.original_branch] : ['checkout', '--quiet', '--detach', job.original_sha];
      const r = await run('git', back, { cwd: dir, timeoutMs: 60_000 });
      if (r.code !== 0) { job.notes.push(`could not switch back to ${job.original_branch || job.original_sha}: ${trunc(r.stderr.trim(), 200)}`); return; }
      m.appendTranscript(job, `restored checkout to ${job.original_branch || job.original_sha}`);
    }
    if (!job.experiment?.kept && await branchExists(dir, job.branch)) {
      const r = await run('git', ['branch', '-D', job.branch], { cwd: dir });
      if (r.code === 0) { m.appendTranscript(job, `removed ${job.branch} (nothing kept)`); job.branch = null; }
    }
  } catch (e) {
    job.notes.push(`checkout restore error: ${scrub(e.message)}`);
  }
}

function appendResultRow(m, job, cells) {
  const file = path.join(m.jobDir(job.id), 'results.tsv');
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'attempt\tcommit\tmetric\tstatus\tdescription\n');
    fs.appendFileSync(file, cells.map(c => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n');
  } catch { /* the job record carries the same rows */ }
}

// ---------- the loop ----------

export async function runExperiment(m, job) {
  let settle;
  job._settled = new Promise(r => { settle = r; });
  try {
    await experiment(m, job);
  } catch (e) {
    m.log.error(`experiment ${job.id} crashed: ${e.stack || e.message}`);
    job.error_code = typeof e.code === 'string' ? e.code : 'internal_error';
    await restoreCheckout(m, job);
    if (typeof job.experiment?.baseline === 'number') job.result_text = report(job, m.cfg);
    m.finish(job, 'failed', `${job.error_code}: ${scrub(e.message)}`);
  } finally {
    settle();
  }
}

async function experiment(m, job) {
  const dir = job.project_path, cfg = m.cfg, x = job.experiment, o = experimentOptions(cfg);
  const deadline = Date.now() + job.limits.timeout_minutes * 60_000;
  const within = ms => Math.max(1000, Math.min(ms, deadline - Date.now()));
  const say = line => m.appendTranscript(job, line);
  const act = text => { job.activity = text; m.save(job); };
  const identity = m.commitIdentity();
  const remote = await hasRemote(dir);

  const fail = async (code, message) => {
    job.error_code = code;
    await restoreCheckout(m, job);
    if (typeof x.baseline === 'number') job.result_text = report(job, cfg);
    m.finish(job, 'failed', `${code}: ${message}`);
  };
  const cancelled = async () => {
    x.stop_reason = 'cancelled by request';
    await restoreCheckout(m, job);
    job.commits = x.kept;
    job.result_text = report(job, cfg);
    job.notes.push(x.kept ? `cancelled; ${x.kept} kept commit(s) remain on ${job.branch}` : 'cancelled; nothing was kept and the checkout is as it was');
    m.finish(job, 'cancelled', 'cancelled by request');
  };

  // Cancelled: drop the attempt in progress and report. Shutting down: stop where it is; the next start puts the checkout back.
  const halted = () => job._cancelling || m._shuttingDown;
  const halt = () => (m._shuttingDown ? undefined : cancelled());

  // ---- where the experiment starts from ----
  if ((await workingTreeStatus(dir)).dirty) return m.finish(job, 'failed', 'Project changed while queued; preserving it');
  let startPoint = 'HEAD';
  if (cfg.execution_branch) {
    const branch = cfg.execution_branch;
    if (currentBranchFast(dir) !== branch) return m.finish(job, 'failed', `Checkout must be on ${branch}`);
    job.original_branch = branch; job.base_branch = branch;
    if (remote) {
      act(`reconciling origin/${branch}`);
      try {
        const sync = await reconcileBranch(dir, branch, `rescue/bridge-${job.id}`);
        job.rescue_ref = sync.rescue_ref;
      } catch (e) {
        job.rescue_ref = e.rescue_ref || null;
        job.error_code = typeof e.code === 'string' ? e.code : 'checkout_sync_failed';
        return m.finish(job, 'failed', `${job.error_code}: ${job.project} (${branch}): ${e.message}`);
      }
    }
  } else {
    job.original_branch = currentBranchFast(dir);
    const base = job.base_branch || await defaultBranch(dir, projectOverrides(cfg, job.project).default_branch);
    job.base_branch = base;
    startPoint = base;
    if (remote) {
      act(`fetching origin/${base}`);
      const r = await run('git', ['fetch', '--quiet', 'origin', base], { cwd: dir, timeoutMs: 120_000 });
      if (r.code === 0) startPoint = `origin/${base}`;
      else job.notes.push(`fetch of origin/${base} failed; starting from local ${base}`);
    }
    if (startPoint === base && !(await branchExists(dir, base))) return m.finish(job, 'failed', `base branch ${base} does not exist in ${job.project}`);
  }
  job.original_sha = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
  x.base_sha = (await git(['rev-parse', startPoint], { cwd: dir })).trim();
  const slug = x.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '') || 'experiment';
  const name = `${o.branch_prefix}${slug}-${job.id.slice(2, 10)}`;
  await git(['checkout', '--quiet', '-b', name, x.base_sha], { cwd: dir, timeoutMs: 60_000 });
  job.branch = name;
  m.save(job, { immediate: true });
  say(`experiment branch ${name} created at ${x.base_sha.slice(0, 8)}`);

  // ---- setup, then the baseline every attempt is compared with ----
  const check = async () => {
    const r = await runShell(m, job, x.check_command, { timeoutMs: within(x.measure_timeout_seconds * 1000) });
    if (r.timedOut) return `the check command did not finish within ${x.measure_timeout_seconds}s`;
    return r.code === 0 ? null : `the check command exited with code ${r.code}: ${tail(r)}`;
  };
  const measure = async () => {
    const values = [];
    for (let i = 0; i < x.measure_runs; i++) {
      const r = await runShell(m, job, x.measure_command, { timeoutMs: within(x.measure_timeout_seconds * 1000) });
      if (halted()) return { why: 'cancelled' };
      if (r.timedOut) return { why: `the measurement did not finish within ${x.measure_timeout_seconds}s` };
      if (r.code !== 0) return { why: `the measurement exited with code ${r.code}: ${tail(r)}` };
      const v = parseMetric(r.stdout, x.metric_name);
      if (v === null) return { why: `the measurement printed no "${x.metric_name}: <number>" line. Its output ended: ${tail(r)}` };
      values.push(v);
    }
    return { value: median(values) };
  };

  if (x.setup_command) {
    act('running the setup command');
    say(`setup: ${trunc(x.setup_command, 200)}`);
    const r = await runShell(m, job, x.setup_command, { timeoutMs: within(o.setup_timeout_seconds * 1000) });
    if (halted()) return halt();
    if (r.timedOut || r.code !== 0) return fail('setup_failed', `the setup command ${r.timedOut ? `did not finish within ${o.setup_timeout_seconds}s` : `exited with code ${r.code}`}: ${tail(r)}`);
    let st = await workingTreeStatus(dir);
    // An install rewrites the lock file even when no dependency changed; that is the sandbox, not a change.
    if (st.dirty && (await m.restoreLockChurn(dir, st.entries)).length) st = await workingTreeStatus(dir);
    if (st.dirty) return fail('setup_failed', `the setup command left uncommitted changes (${st.entries.slice(0, 5).join(', ')}); it may only produce files that git ignores`);
  }
  if (x.check_command) {
    act('checking the baseline');
    const why = await check();
    if (halted()) return halt();
    if (why) return fail('baseline_check_failed', `${why}. The check has to pass before any change, or no attempt could be kept`);
    await cleanTree(dir);
  }
  act('measuring the baseline');
  const base = await measure();
  if (halted()) return halt();
  if (base.why) return fail('baseline_failed', `${base.why}. Nothing was changed`);
  await cleanTree(dir);
  x.baseline = base.value; x.best = base.value;
  appendResultRow(m, job, [0, x.base_sha.slice(0, 8), fmt(x.baseline), 'baseline', '']);
  say(`baseline ${x.metric_name} = ${fmt(x.baseline)}`);
  m.save(job, { immediate: true });

  // ---- attempts ----
  const ceiling = job.limits.max_cost_usd;
  const attemptBudget = Math.round(Math.max(0.25, ceiling * o.attempt_cost_share) * 100) / 100;
  const system = systemPrompt(m, job, attemptBudget);
  let session = null, sinceKeep = 0, prompt = firstPrompt(x);
  let costBase = 0; // spend of sessions before the current one
  for (let n = 1; n <= x.max_iterations && !x.stop_reason; n++) {
    if (halted()) return halt();
    if (deadline - Date.now() < 30_000) { x.stop_reason = `the ${job.limits.timeout_minutes}-minute time limit was reached`; break; }
    const remaining = ceiling - (job.cost_usd || 0);
    if (remaining < 0.1) { x.stop_reason = `the $${ceiling} cost ceiling was reached`; break; }
    const head = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
    const budget = Math.round(Math.min(remaining, attemptBudget) * 100) / 100;

    // One agent turn. The stream state is per turn; the session carries the context between turns.
    job._results = []; job._lastText = ''; job._budgetStop = false; job._resultError = null; job._resultSeen = false;
    const args = m.claudeArgs({ ...job, prompt, mode: 'execute', agent: null, ticket_input: null, resume_session: session, limits: { ...job.limits, max_cost_usd: budget }, _system_prompt: system }, { remote });
    act(`attempt ${n}/${x.max_iterations}: proposing a change (best ${fmt(x.best)})`);
    say(`-- attempt ${n}: agent turn (budget $${budget}${session ? `, resuming ${session}` : ''})`);
    const spentBefore = job.cost_usd || 0;
    const sessionBefore = job.session_cost_usd || 0;
    const exit = await m.spawnClaude(job, args, { timeoutMs: within(o.attempt_minutes * 60_000) });
    // A session reports spend for its whole life; a session that did not carry over starts again from nothing.
    if ((job.session_cost_usd || 0) < sessionBefore) costBase = spentBefore;
    job.cost_usd = round4(costBase + (job.session_cost_usd || 0));
    session = job.session_id || session;
    const text = (job._results.at(-1) || job._lastText || '').trim();
    const a = { n, status: null, metric: null, commit: null, description: describeChange(text), detail: null, cost_usd: round4(job.cost_usd - spentBefore) };
    if (halted()) { if (!m._shuttingDown) await cleanTree(dir, head); return halt(); }

    // Whatever the agent did with git, the candidate is the tree it left, compared with where the turn started.
    let strayed = false;
    if (currentBranchFast(dir) !== job.branch) {
      strayed = true;
      await run('git', ['checkout', '--force', '--quiet', job.branch], { cwd: dir, timeoutMs: 60_000 });
      // Whatever it did to the branch the experiment started from is undone too: that branch is published by other jobs.
      if (job.original_branch) await run('git', ['branch', '--force', job.original_branch, job.original_sha], { cwd: dir, timeoutMs: 60_000 });
    }
    await run('git', ['reset', '--soft', head], { cwd: dir, timeoutMs: 60_000 });
    // Lock-file churn from an install during the turn is not part of the change, in scope or out of it.
    const left = await workingTreeStatus(dir);
    if (left.dirty) await m.restoreLockChurn(dir, left.entries);
    await run('git', ['add', '-A'], { cwd: dir, timeoutMs: 60_000 });
    const changed = (await git(['diff', '--cached', '--name-only', '--no-renames', head], { cwd: dir, timeoutMs: 60_000 })).split('\n').filter(Boolean);
    const outside = changed.filter(f => !inScope(f, x.editable));

    const agentError = job._resultError || (exit.code !== 0 && !job._resultSeen && !exit.timedOut ? `claude exited with code ${exit.code}${exit.lastStderr ? `: ${trunc(exit.lastStderr, 300)}` : ''}` : null);
    if (strayed) { a.status = 'rule_break'; a.detail = 'the checkout was moved off the experiment branch'; }
    else if (exit.timedOut) a.status = 'timeout';
    else if (job._budgetStop) a.status = 'budget';
    else if (agentError) { a.status = 'error'; a.detail = trunc(agentError, 300); }
    else if (!changed.length) a.status = saidDone(text) ? 'done' : 'no_change';
    else if (outside.length) { a.status = 'out_of_scope'; a.detail = `changed outside the editable paths: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? ` and ${outside.length - 8} more` : ''}`; }

    if (a.status) {
      await cleanTree(dir, head);
    } else {
      // Commit first, so anything the check or the measurement writes can be cleaned away without touching the candidate.
      const c = await run('git', [...identity, 'commit', '--quiet', '-m', `experiment: ${a.description || `attempt ${n}`}\n\nAttempt ${n} of bridge experiment ${job.id} (${x.metric_name}, ${x.direction}).`], { cwd: dir, timeoutMs: 120_000 });
      if (c.code !== 0) {
        a.status = 'check_failed'; a.detail = `the commit was rejected: ${tail(c, 300)}`;
        await cleanTree(dir, head);
      } else {
        let why = null;
        if (x.check_command) {
          act(`attempt ${n}/${x.max_iterations}: running the check`);
          why = await check();
          await cleanTree(dir);
        }
        if (halted()) { if (!m._shuttingDown) await cleanTree(dir, head); return halt(); }
        if (why) {
          a.status = 'check_failed'; a.detail = why;
          await cleanTree(dir, head);
        } else {
          act(`attempt ${n}/${x.max_iterations}: measuring`);
          const got = await measure();
          await cleanTree(dir);
          if (halted()) { if (!m._shuttingDown) await cleanTree(dir, head); return halt(); }
          if (got.why) {
            a.status = 'crash'; a.detail = got.why;
            await cleanTree(dir, head);
          } else {
            a.metric = got.value;
            if (isBetter(got.value, x.best, x.direction, x.min_improvement)) {
              a.status = 'keep';
              a.commit = (await git(['rev-parse', '--short=8', 'HEAD'], { cwd: dir })).trim();
              x.best = got.value; x.best_attempt = n; x.kept += 1;
            } else {
              a.status = 'discard';
              await cleanTree(dir, head);
            }
          }
        }
      }
    }

    x.attempts.push(a);
    job.commits = x.kept;
    appendResultRow(m, job, [n, a.commit || '', fmt(a.metric), a.status, [a.description, a.detail].filter(Boolean).join(' — ')]);
    say(`== attempt ${n}: ${a.status}${a.metric !== null ? ` (${x.metric_name} = ${fmt(a.metric)}, best ${fmt(x.best)})` : ''}${a.detail ? ` — ${trunc(a.detail, 300)}` : ''}`);
    m.save(job, { immediate: true });

    sinceKeep = a.status === 'keep' ? 0 : sinceKeep + 1;
    if (a.status === 'error') x.stop_reason = `the agent session failed (${a.detail})`;
    else if (a.status === 'done') x.stop_reason = `the agent had no further change worth measuring${a.description ? ` (${a.description})` : ''}`;
    else if (a.status === 'keep' && targetReached(x.best, x.target, x.direction)) x.stop_reason = `the target of ${fmt(x.target)} was reached`;
    else if (sinceKeep >= x.patience) x.stop_reason = `no improvement in ${x.patience} consecutive attempt${x.patience === 1 ? '' : 's'}`;
    else if (n === x.max_iterations) x.stop_reason = `all ${x.max_iterations} attempts were used`;
    prompt = feedbackPrompt(x, a, x.max_iterations - n);
  }
  x.stop_reason ||= `all ${x.max_iterations} attempts were used`;

  await restoreCheckout(m, job);
  job.commits = x.kept;
  job.pushed = false;
  job.result_text = report(job, cfg);
  // An experiment whose only attempts were agent failures did not run; say so as a failure.
  if (x.attempts.length && x.attempts.every(a => a.status === 'error')) {
    job.error_code = 'agent_failed';
    return m.finish(job, 'failed', `agent_failed: ${x.stop_reason}`);
  }
  m.finish(job, 'completed');
}

// ---------- apply ----------

/**
 * Publish an experiment's kept commits the way this bridge publishes any work: on a demo bridge,
 * onto the execution branch and pushed; otherwise the experiment branch is pushed and a draft PR opened.
 */
export async function applyExperiment(m, { job_id }) {
  const job = m.get(job_id);
  const cfg = m.cfg, x = job.experiment;
  if (job.kind !== 'experiment' || !x) throw new Error(`${job_id} is not an experiment`);
  if (['queued', 'running'].includes(job.state)) throw new Error(`${job_id} is still ${job.state}; wait for it to finish or cancel it`);
  if (x.applied) throw new Error(`${job_id} was already applied (${x.applied.summary})`);
  if (!x.kept || !job.branch) throw new Error(`${job_id} kept no changes, so there is nothing to apply`);
  const dir = job.project_path;
  return m.withComposeLock(job.project, 'applying an experiment', async () => {
    if (!(await branchExists(dir, job.branch))) throw new Error(`branch ${job.branch} no longer exists in ${job.project}`);
    const st = await workingTreeStatus(dir, { timeoutMs: 20_000 });
    if (st.dirty) throw Object.assign(new Error(`refused: ${job.project} has uncommitted changes. Commit or stash them first.\n${st.entries.slice(0, 20).join('\n')}`), { code: 'DIRTY_TREE' });
    const remote = await hasRemote(dir);
    const count = Number((await git(['rev-list', '--count', `${x.base_sha}..${job.branch}`], { cwd: dir })).trim());
    let applied;
    if (cfg.execution_branch) {
      const branch = cfg.execution_branch;
      if (currentBranchFast(dir) !== branch) throw new Error(`Checkout must be on ${branch}`);
      if (remote) await reconcileBranch(dir, branch, `rescue/bridge-apply-${job.id}`);
      const before = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
      let method;
      if (before === x.base_sha) {
        await git(['merge', '--ff-only', '--quiet', job.branch], { cwd: dir, timeoutMs: 60_000 });
        method = 'fast-forward';
      } else {
        const r = await run('git', [...m.commitIdentity(), 'cherry-pick', `${x.base_sha}..${job.branch}`], { cwd: dir, timeoutMs: 120_000 });
        if (r.code !== 0) {
          const conflicts = (await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir })).stdout.trim().split('\n').filter(Boolean);
          await run('git', ['cherry-pick', '--abort'], { cwd: dir });
          await cleanTree(dir, before);
          throw new GitError(`${branch} has moved since the experiment and its commits no longer apply cleanly${conflicts.length ? ` (conflicts: ${conflicts.join(', ')})` : ''}. Nothing was changed; the commits are still on ${job.branch}. Run the experiment again from the current ${branch}.`, { code: 'apply_conflict' });
        }
        method = 'cherry-pick';
      }
      const after = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
      let pushed = false;
      if (remote) {
        const r = await run('git', ['push', '--quiet', 'origin', `${branch}:${branch}`], { cwd: dir, timeoutMs: 180_000 });
        if (r.code !== 0) {
          await cleanTree(dir, before);
          throw new GitError(`push to origin/${branch} failed, so the checkout was put back as it was; the commits are still on ${job.branch}. ${trunc(r.stderr.trim(), 400)}`, { code: 'publication_failed' });
        }
        pushed = true;
      }
      const moved = method === 'cherry-pick';
      applied = {
        at: new Date().toISOString(), method, commits: count, head_before: before, head_after: after, pushed, branch,
        summary: `${count} commit${count === 1 ? '' : 's'} put on ${branch} by ${method}${pushed ? ' and pushed' : ' (no remote, so nothing was pushed)'}; ${branch} is now ${after.slice(0, 8)}.${moved ? ` ${branch} had moved since the experiment, so the measured ${x.metric_name} = ${fmt(x.best)} was not re-measured on the new base.` : ''}`,
      };
    } else {
      if (!remote) throw new Error(`${job.project} has no remote; the kept commits are on local branch ${job.branch} for review there`);
      const r = await run('git', ['push', '--quiet', '-u', 'origin', `${job.branch}:${job.branch}`], { cwd: dir, timeoutMs: 180_000 });
      if (r.code !== 0) throw new GitError(`push of ${job.branch} failed: ${trunc(r.stderr.trim(), 400)}`, { code: 'publication_failed' });
      job.pushed = true;
      await m.openDraftPr(job);
      applied = {
        at: new Date().toISOString(), method: 'branch', commits: count, pushed: true, branch: job.branch, pr_url: job.pr_url || undefined,
        summary: `${count} commit${count === 1 ? '' : 's'} pushed as ${job.branch}${job.pr_url ? `; draft PR ${job.pr_url}` : '; no PR was opened (see notes)'}. Nothing was merged.`,
      };
    }
    x.applied = applied;
    job.pushed = applied.pushed;
    job.result_text = report(job, cfg);
    m.appendTranscript(job, `applied: ${applied.summary}`);
    m.save(job, { immediate: true });
    return { job_id: job.id, project: job.project, applied: true, ...applied };
  });
}
