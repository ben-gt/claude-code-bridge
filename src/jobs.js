// Job manager: queueing, running Claude Code headless, stream parsing, persistence,
// branch/PR handling, cancellation and restart recovery.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveProjectDir, BoundaryError } from './paths.js';
import { projectOverrides } from './config.js';
import { detectClaudeSetup } from './projects.js';
import { git, run, defaultBranch, workingTreeStatus, hasRemote, branchExists, remoteUrlFast, parseRemote, worktreeAdd, worktreeDiscard, GitError } from './git.js';
import { scrub, scrubDeep } from './scrub.js';
import { apiFetch, hostConfigFor } from './credentials.js';
import { selectModel, EFFORT_LEVELS } from './models.js';
import { resolveComposeTarget, composeConfig, composeStatus, composeStream, validateServices, killGroup as composeKill, isProtected } from './compose.js';

export const STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
const ACTIVE = new Set(['queued', 'running']);
// Most recent activity steps carried back by a long poll (see waitForChange).
const TRAIL_MAX = 12;

function newJobId() {
  return `j_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function slugify(text, max = 28) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'task';
}

function nowIso() { return new Date().toISOString(); }
function hhmmss() { return new Date().toISOString().slice(11, 19); }
function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class JobManager {
  constructor(cfg, projectIndex, { log = console, goals = null, notify = null, asker = null } = {}) {
    this.cfg = cfg;
    this.goals = goals;
    this.notify = notify;
    this.asker = asker;
    this.projects = projectIndex;
    this.log = log;
    this.jobsDir = path.join(cfg.data_dir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.jobs = new Map();      // id -> record
    this.procs = new Map();     // id -> { child, timer }
    this.writeTimers = new Map();
    this.composeLocks = new Map(); // project -> description of a synchronous compose op in flight
  }

  // ---------- persistence ----------
  recordFile(id) { return path.join(this.jobsDir, id, 'job.json'); }
  jobDir(id) { return path.join(this.jobsDir, id); }

  save(job, { immediate = false } = {}) {
    const write = () => {
      this.writeTimers.delete(job.id);
      try { atomicWrite(this.recordFile(job.id), JSON.stringify(job, (k, v) => (k.startsWith('_') ? undefined : v), 2)); } catch (e) { this.log.error(`save ${job.id}: ${e.message}`); }
    };
    if (immediate) { clearTimeout(this.writeTimers.get(job.id)); write(); return; }
    if (!this.writeTimers.has(job.id)) this.writeTimers.set(job.id, setTimeout(write, 1000));
  }

  init() {
    let loaded = 0, interrupted = 0;
    for (const id of fs.existsSync(this.jobsDir) ? fs.readdirSync(this.jobsDir) : []) {
      try {
        const job = JSON.parse(fs.readFileSync(this.recordFile(id), 'utf8'));
        if (ACTIVE.has(job.state)) {
          if (pidAlive(job.pid)) { try { process.kill(-job.pid, 'SIGKILL'); } catch { try { process.kill(job.pid, 'SIGKILL'); } catch { /* gone */ } } }
          job.state = 'interrupted';
          job.finished_at = job.finished_at || nowIso();
          job.error = job.error || 'server restarted while the job was active; its worktree was removed — any commits survive on the job branch';
          job.activity = 'interrupted';
          this.appendTranscript(job, `!! job marked interrupted at server start (${job.error})`);
          atomicWrite(this.recordFile(id), JSON.stringify(job, null, 2));
          interrupted++;
        }
        this.jobs.set(id, job);
        loaded++;
      } catch { /* skip corrupt */ }
    }
    this.log.info(`jobs: loaded ${loaded} record(s), ${interrupted} marked interrupted`);
    this.pruneOld();
    this.sweepWorktrees().catch(e => this.log.error(`worktree sweep failed: ${e.message}`));
  }

  /** Remove worktrees left behind by interrupted/crashed jobs (startup housekeeping). */
  async sweepWorktrees() {
    const wtRoot = path.join(this.cfg.data_dir, 'worktrees');
    let entries = [];
    try { entries = fs.readdirSync(wtRoot); } catch { return; }
    for (const id of entries) {
      const job = this.jobs.get(id);
      if (job && ACTIVE.has(job.state)) continue;
      const wt = path.join(wtRoot, id);
      const repo = job?.project_path;
      if (repo) await worktreeDiscard(repo, wt);
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
      if (job) job.worktree = null;
    }
    if (entries.length) this.log.info(`worktrees: swept ${entries.length} leftover(s)`);
  }

  pruneOld(keep = 500) {
    const all = [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const j of all.slice(keep)) {
      if (ACTIVE.has(j.state)) continue;
      try { fs.rmSync(this.jobDir(j.id), { recursive: true, force: true }); } catch { /* ignore */ }
      this.jobs.delete(j.id);
    }
  }

  appendTranscript(job, line) {
    try { fs.appendFileSync(path.join(this.jobDir(job.id), 'transcript.log'), `[${hhmmss()}] ${scrub(line)}\n`); } catch { /* ignore */ }
  }

  // ---------- queries ----------
  get(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job_id ${id}`);
    return j;
  }

  list({ limit = 20, project, state } = {}) {
    const max = Math.min(limit, this.cfg.limits.list_jobs_max ?? 50);
    return [...this.jobs.values()]
      .filter(j => (!project || j.project === project) && (!state || j.state === state))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, max)
      .map(j => ({
        job_id: j.id, kind: j.kind || 'claude', state: j.state, project: j.project, mode: j.mode, created_at: j.created_at,
        elapsed_seconds: elapsedSeconds(j), summary: j.summary, branch: j.branch || undefined, pr_url: j.pr_url || undefined,
        cost_usd: j.cost_usd ?? undefined, model: j.model || undefined, error: j.error || undefined,
      }));
  }

  /**
   * Block until the job finishes, or timeoutMs elapses. Returns the distinct
   * activity steps observed while waiting.
   *
   * This used to resolve on any `activity` change too — which sounds like a
   * long poll and isn't: activity ticks over on every tool the agent uses, so
   * a 20s wait typically returned in a second or two. Measured on the calling
   * side that came to ~18 get_task_status calls per job, and each one is a
   * full model round-trip that resends the entire conversation. So only a
   * TERMINAL state wakes this early now; progress is collected into the trail
   * and reported in one go, which reads better anyway ("installed deps, ran
   * tests, opened PR") than a single stale snapshot per call.
   */
  waitForChange(id, timeoutMs) {
    const j = this.get(id);
    if (!ACTIVE.has(j.state)) return Promise.resolve([]);
    const trail = [];
    let last = j.activity;
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        const cur = this.jobs.get(id);
        if (!cur) return resolve(trail);
        if (cur.activity && cur.activity !== last) {
          last = cur.activity;
          // Cap the trail: a chatty job must not turn one poll into a wall of
          // text, which is the cost we are here to remove. Keep the newest.
          trail.push(`+${elapsedSeconds(cur)}s ${cur.activity}`);
          if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
        }
        if (!ACTIVE.has(cur.state)) return resolve(trail);
        if (Date.now() - started >= timeoutMs) return resolve(trail);
        setTimeout(tick, 500);
      };
      setTimeout(tick, 500);
    });
  }

  status(id, { trail } = {}) {
    const j = this.get(id);
    const active = ACTIVE.has(j.state);
    if (active) {
      // Lean while running: callers poll this, and every byte lands in the chat context.
      return scrubDeep({
        job_id: j.id, kind: j.kind || 'claude', state: j.state, project: j.project, mode: j.mode,
        elapsed_seconds: elapsedSeconds(j), activity: j.activity, branch: j.branch || undefined,
        model: j.model || j.model_selected || undefined, cost_usd: j.cost_usd ?? undefined,
        queue_position: j.state === 'queued' ? this.queuePosition(j.id) : undefined,
        compose_steps: j.compose?.steps?.length ? j.compose.steps.map(s => `${s.name}=${s.state}`).join(', ') : undefined,
        steps_while_waiting: trail && trail.length ? trail : undefined,
        hint: 'still running — this call already waited; just call again to keep waiting (it blocks until the job ends or wait_seconds runs out). Do not poll in a tight loop: every call re-sends the whole conversation to the model. get_task_log for detail.',
      });
    }
    return scrubDeep({
      job_id: j.id, kind: j.kind || 'claude', state: j.state, project: j.project, mode: j.mode, agent: j.agent || undefined,
      created_at: j.created_at, started_at: j.started_at || undefined, finished_at: j.finished_at || undefined,
      elapsed_seconds: elapsedSeconds(j), activity: j.activity,
      base_branch: j.base_branch || undefined, branch: j.branch || undefined, original_branch: j.original_branch || undefined,
      commits: j.commits ?? undefined, pushed: j.pushed ?? undefined, pr_url: j.pr_url || undefined,
      session_id: j.session_id || undefined,
      model: j.model || j.model_selected || undefined, model_selected: j.model_selected || undefined, tier: j.tier || undefined, model_reason: j.model_reason || undefined,
      effort: j.effort_selected || undefined, effort_reason: j.effort_reason || undefined,
      compose: j.compose || undefined,
      cost_usd: j.cost_usd ?? undefined, usage: j.usage || undefined, num_turns: j.num_turns ?? undefined,
      limits: j.limits,
      result: j.result_text ? trunc(j.result_text, 4000) : undefined,
      plan_file: j.plan_file || undefined,
      error: j.error || undefined, notes: j.notes?.length ? j.notes : undefined,
      queue_position: j.state === 'queued' ? this.queuePosition(j.id) : undefined,
    });
  }

  readLog(id, { offset = 0, limit = 16384, raw = false } = {}) {
    const j = this.get(id);
    const file = path.join(this.jobDir(id), raw ? 'stream.jsonl' : 'transcript.log');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* none yet */ }
    const start = Math.max(0, Math.min(offset, size));
    const len = Math.max(0, Math.min(limit, size - start));
    let text = '';
    if (len > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    }
    return { job_id: id, state: j.state, offset: start, next_offset: start + len, total_bytes: size, eof: !ACTIVE.has(j.state) && start + len >= size, text: scrub(text) };
  }

  queuePosition(id) {
    const q = [...this.jobs.values()].filter(j => j.state === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at));
    return q.findIndex(j => j.id === id) + 1;
  }

  runningCount() { return [...this.jobs.values()].filter(j => j.state === 'running').length; }

  /** Jobs already in flight on the same project.
   *
   *  Worktrees keep concurrent jobs from corrupting each other's files, so this
   *  is not a safety gate — it is an attention gate. Two agents surveying one
   *  repo at once reach conclusions the other never sees (the blackboard is
   *  read when a child starts, so a sibling that started at the same moment
   *  contributes nothing to it), and you pay for both. Worth saying out loud
   *  before dispatch rather than discovering in the bill. */
  activeIn(project, exceptId = null) {
    return [...this.jobs.values()].filter(j =>
      j.project === project && j.id !== exceptId &&
      (j.state === 'running' || j.state === 'queued'),
    );
  }

  /** Name of the first predecessor that has not finished yet, or null when the
   *  job is free to run. A predecessor that FAILED still counts as finished —
   *  the dependent child is told about it through the blackboard and can decide
   *  what to do, which is better than silently stranding it forever. */
  blockedBy(job) {
    for (const id of job.depends_on || []) {
      const dep = this.jobs.get(id);
      if (!dep) return `${id} (unknown job)`;
      if (dep.state === 'queued' || dep.state === 'running') return `${dep.project} (${id})`;
    }
    return null;
  }

  /**
   * Compose ops need the project's containers (and checkout, for builds) to
   * themselves. Claude jobs run in isolated worktrees and never contend, so
   * they are deliberately NOT part of this check: a running task must never
   * block "restart the stack" or vice versa.
   */
  assertComposeFree(project, what) {
    const lock = this.composeLocks.get(project);
    if (lock) throw new Error(`refused: ${project} has a compose operation in progress (${lock}); ${what} would fight it`);
    const busy = [...this.jobs.values()].find(j => j.project === project && j.kind === 'compose_redeploy' && ACTIVE.has(j.state));
    if (busy) throw new Error(`refused: ${project} already has an active compose redeploy (${busy.id}, ${busy.state})`);
  }

  /** Hold a short lock while a synchronous compose op runs. */
  async withComposeLock(project, what, fn) {
    this.assertComposeFree(project, what);
    this.composeLocks.set(project, what);
    try { return await fn(); } finally { this.composeLocks.delete(project); }
  }

  /** Most recent failed Claude job on the same project with the same prompt (for retry escalation). */
  findPriorFailure(project, prompt, retryOf) {
    const norm = t => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
    // A job that died because the ACCOUNT ran out of room did not fail at the
    // task — it never got to attempt it. Escalating that to a bigger model
    // answers a question nobody asked and bills the most expensive tier for
    // it. On 2026-08-30 a session cap binned five queued jobs in 21 seconds;
    // retrying them by prompt would have sent every one to the complex tier.
    const quotaFailure = err => /session limit|usage limit|rate limit|quota|(more|out of) credits|429/i.test(String(err || ''));
    const describe = j => (
      quotaFailure(j.error) ? { why: 'hit an account limit rather than failing the task', quota: true }
        : /cost ceiling/i.test(String(j.error || '')) ? { why: 'hit its cost ceiling', quota: false }
        : { why: `ended ${j.state}`, quota: false }
    );
    if (retryOf) {
      const j = this.jobs.get(retryOf);
      if (!j) throw new Error(`retry_of ${retryOf} is not a known job`);
      return { id: j.id, ...describe(j) };
    }
    const prev = [...this.jobs.values()]
      .filter(j => (j.kind || 'claude') === 'claude' && j.project === project && ['failed', 'interrupted'].includes(j.state) && norm(j.prompt) === norm(prompt))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!prev) return null;
    // Only the most recent attempt matters; if it later succeeded, no escalation.
    const newer = [...this.jobs.values()].find(j => j.project === project && norm(j.prompt) === norm(prompt) && j.state === 'completed' && j.created_at > prev.created_at);
    if (newer) return null;
    return { id: prev.id, ...describe(prev) };
  }

  // ---------- start ----------
  async start({ project, prompt, agent, base_branch, mode = 'plan', max_cost_usd, timeout_minutes, model, complexity, effort, retry_of, goal_id, depends_on, chat_id }) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    if (!['plan', 'execute'].includes(mode)) throw new Error(`mode must be "plan" or "execute" (got ${mode})`);
    const dir = resolveProjectDir(this.cfg, project);
    const name = path.relative(fs.realpathSync(this.cfg.workspace_root), dir);
    const ov = projectOverrides(this.cfg, name);
    const setup = detectClaudeSetup(dir);
    if (agent && !setup.agents.some(a => a.name === agent)) {
      throw new Error(`agent "${agent}" not found in ${name}/.claude/agents (available: ${setup.agents.map(a => a.name).join(', ') || 'none'})`);
    }
    if (base_branch && (!/^[A-Za-z0-9._\/-]{1,200}$/.test(base_branch) || base_branch.startsWith('-') || base_branch.includes('..'))) throw new Error('invalid base_branch');
    if (complexity && !['low', 'normal', 'high'].includes(complexity)) throw new Error('complexity must be low, normal or high');
    if (effort && !EFFORT_LEVELS.includes(effort)) throw new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
    // The goal budget is checked BEFORE dispatch. Checking after would mean
    // discovering the ceiling by exceeding it, which for a fan-out is the
    // expensive way round.
    if (depends_on?.length && !goal_id) throw new Error('depends_on is only meaningful inside a goal');
    // Surfaced, never enforced: refusing would break legitimate parallel work
    // (a goal deliberately fanning several jobs into one repo), and a silent
    // dispatch is how you end up paying twice for contradictory answers.
    const clash = this.activeIn(name);
    if (goal_id) {
      if (!this.goals) throw new Error('goals are not enabled on this bridge');
      const gate = this.goals.canDispatch(goal_id, this.jobs);
      if (!gate.ok) throw new Error(`cannot dispatch into goal ${goal_id}: ${gate.why}`);
    }
    const priorFailure = this.findPriorFailure(name, prompt, retry_of);
    const choice = selectModel(this.cfg, { projectOverrides: ov, prompt, mode, agent, setup, explicitModel: model, complexity, priorFailure, explicitEffort: effort });

    // Jobs run in a disposable worktree created from committed state, so a
    // dirty checkout never blocks a job — but uncommitted work is invisible
    // to it, which is worth saying out loud instead of silently ignoring.
    let dirtyNote = null;
    try {
      const st = await workingTreeStatus(dir, { includeUntracked: !ov.allow_untracked, timeoutMs: 20_000 });
      if (st.dirty) dirtyNote = `${name}'s checkout has ${st.entries.length} uncommitted change(s); this job runs from committed state and cannot see them`;
    } catch { /* advisory only */ }
    if (mode === 'execute' && !base_branch) {
      const def = await defaultBranch(dir, ov.default_branch);
      if (!def) throw new Error(`${name} has no inferable default branch (detached HEAD, no main/master?) — pass base_branch`);
    }

    const limits = {
      timeout_minutes: timeout_minutes ?? ov.job_timeout_minutes ?? this.cfg.limits.job_timeout_minutes,
      // Ceiling precedence: explicit arg > project override > tier ceiling > global.
      max_cost_usd: max_cost_usd ?? ov.max_cost_usd ?? choice.max_cost_usd ?? this.cfg.limits.max_cost_usd,
    };
    const id = newJobId();
    const job = {
      id, kind: 'claude', project: name, project_path: dir, mode, agent: agent || null, prompt: scrub(prompt), summary: trunc(prompt.replace(/\s+/g, ' ').trim(), 100),
      model_selected: choice.model, tier: choice.tier, model_reason: choice.reason,
      effort_selected: choice.effort || null, effort_reason: choice.effort_reason || null,
      goal_id: goal_id || null, depends_on: depends_on?.length ? [...depends_on] : null,
      // Where this was asked for. Carried only so the channel feed can link
      // back to the conversation; never used for auth or lookup.
      chat_id: chat_id || null,
      goal_label: goal_id && this.goals ? this.goals.label(goal_id) : null,
      retry_of: priorFailure?.id || null,
      state: 'queued', created_at: nowIso(), started_at: null, finished_at: null, activity: 'queued',
      base_branch: base_branch || null, branch: null, worktree: null, commits: null, pushed: null, pr_url: null,
      session_id: null, model: null, cost_usd: null, usage: null, num_turns: null, result_text: null, plan_file: null,
      error: null, notes: dirtyNote ? [dirtyNote] : [], pid: null, limits, setup: { claude_md: setup.claude_md, preflight: setup.preflight, agents: setup.agents.map(a => a.name) },
    };
    fs.mkdirSync(this.jobDir(id), { recursive: true });
    this.jobs.set(id, job);
    this.save(job, { immediate: true });
    this.appendTranscript(job, `job ${id} queued: project=${name} mode=${mode}${agent ? ` agent=${agent}` : ''} model=${choice.model} tier=${choice.tier} (${choice.reason})`);
    if (goal_id) this.goals.attach(goal_id, id);
    setImmediate(() => this.pump());
    if (clash.length) {
      const detail = clash.map(j => `${j.id} (${j.state}${j.started_at ? `, ${Math.max(1, Math.round((Date.now() - Date.parse(j.started_at)) / 60000))}m` : ''})`).join(', ');
      this.log.warn(`job ${id}: ${name} already has ${clash.length} job(s) in flight: ${detail}`);
      this.notify?.post(`\u26a0 **${name}** now has ${clash.length + 1} jobs in flight \u2014 they cannot see each other's findings`);
    }
    return { job_id: id, goal_id: goal_id || undefined, state: job.state, project: name, mode, model: choice.model,
      concurrent_on_project: clash.length
        ? { count: clash.length, jobs: clash.map(j => ({ job_id: j.id, state: j.state, summary: j.summary })),
            note: `${name} already has ${clash.length} job(s) in flight. They run in separate worktrees so they cannot corrupt each other, but they cannot see each other's findings either, and you are paying for both. Tell the user before continuing if this was not deliberate.` }
        : undefined, tier: choice.tier, model_reason: choice.reason,
      effort: choice.effort || undefined, effort_reason: choice.effort_reason || undefined, queue_position: this.queuePosition(id), limits };
  }

  /** Start queued jobs while capacity allows. */
  pump() {
    const cap = this.cfg.limits.max_concurrent_jobs ?? 2;
    const queued = [...this.jobs.values()].filter(j => j.state === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const job of queued) {
      if (this.runningCount() >= cap) break;
      // A child with unmet predecessors stays queued. It is skipped, not
      // broken out of: a later job whose dependencies ARE met should still
      // start, otherwise one slow predecessor stalls the whole fan-out.
      const block = this.blockedBy(job);
      if (block) { job.activity = `waiting on ${block}`; continue; }
      job.state = 'running';
      job.started_at = nowIso();
      job.activity = 'starting';
      this.save(job, { immediate: true });
      this.notify?.jobStarted(job);
      const runner = job.kind === 'compose_redeploy' ? this.runComposeJob(job) : this.runJob(job);
      runner.catch(async e => {
        this.log.error(`job ${job.id} crashed: ${e.stack || e.message}`);
        await this.removeWorktree(job).catch(() => {});
        this.finish(job, 'failed', `internal error: ${scrub(e.message)}`);
      });
    }
  }

  /** True when this failure was the ACCOUNT running out of room, not the task
   *  going wrong. Same classification the retry-escalation gate uses. */
  static isQuotaError(err) {
    return /session limit|usage limit|rate limit|quota|(more|out of) credits|429/i.test(String(err || ''));
  }

  /** Recover what a killed job actually established, from its own stream.
   *
   *  result_text is only ever set from the single `result` event at the end of
   *  a run. A job that hits the cost ceiling, times out, or dies with the
   *  container never emits one — so it reports NOTHING, despite every
   *  assistant message it produced sitting in stream.jsonl the whole time.
   *  Twenty jobs died that way for $169.71 and left no trace of what they had
   *  worked out.
   *
   *  This needs no cooperation from the model and no prompt tokens: the record
   *  already exists, it was simply never read. */
  salvagePartial(job) {
    const f = path.join(this.jobDir(job.id), 'stream.jsonl');
    let parts = [];
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type !== 'assistant') continue;
        for (const b of (ev.message?.content || [])) {
          // Visible text only. Thinking blocks are the model's working, not a
          // finding, and quoting them back as a result would misrepresent what
          // the job actually concluded.
          if (b?.type === 'text' && b.text) parts.push(String(b.text));
        }
      }
    } catch { return null; }
    const body = parts.join('\n\n').trim();
    if (!body) return null;
    const tail = body.length > 6000 ? body.slice(-6000) : body;
    return `[PARTIAL — this job was stopped before it finished, so this is what it had established, not a conclusion]\n\n${tail}`;
  }

  finish(job, state, error) {
    if (!ACTIVE.has(job.state)) return;
    // Salvage before the bookkeeping below reads result_text: the blackboard
    // entry, the channel line and the plan file all take what they find here.
    // Not `!job.result_text`: a job killed at its cost ceiling DOES emit a
    // result event, carrying the JSON-serialised empty string — the two
    // characters `""`. That is truthy, so a naive emptiness check skips the
    // salvage on precisely the twenty most expensive failures ($169.71) this
    // exists to rescue.
    if (state !== 'completed' && !String(job.result_text || '').replace(/^["'\s]+|["'\s]+$/g, '')) {
      const partial = this.salvagePartial(job);
      if (partial) {
        job.result_text = scrub(partial);
        job.notes.push('result recovered from the stream after an abnormal stop');
        this.log.info(`job ${job.id}: salvaged ${partial.length} chars of partial work from the stream`);
      }
    }
    // Quota failover. A subscription session cap is a wall the job hit on the
    // way in, not a verdict on the work — on 2026-08-30 one binned five queued
    // jobs in 21 seconds. When an API key is configured we re-queue the job
    // once with that key in its environment, so the fan-out finishes instead
    // of waiting for the cap to reset.
    //
    // Deliberately opt-in and capped: the subscription is flat-rate, an API
    // key is billed per token, so silently failing over would convert a quota
    // stall into a bill. It happens at most once per job (failover_used), only
    // for a genuine quota failure, and only while the goal or job still has
    // budget.
    const fo = this.cfg.failover || {};
    if (
      state === 'failed' && fo.enabled && fo.api_key && !job.failover_used &&
      job.kind !== 'compose_redeploy' && JobManager.isQuotaError(error)
    ) {
      job.failover_used = true;
      job.state = 'queued';
      job.activity = 'quota reached — requeued on the API key';
      job.pid = null;
      job.started_at = null;
      job.error = null;
      this.procs.delete(job.id);
      this.save(job, { immediate: true });
      this.appendTranscript(job, `!! ${scrub(String(error))} -> requeued once on the API key`);
      this.log.warn(`job ${job.id} hit an account limit; requeued on the API key`);
      this.notify?.post(`\u26a1 **${job.project}** hit an account limit — requeued on the API key`);
      setImmediate(() => this.pump());
      return;
    }
    job.state = state;
    job.finished_at = nowIso();
    if (error) job.error = scrub(error);
    job.activity = state;
    job.pid = null;
    this.procs.delete(job.id);
    this.save(job, { immediate: true });
    this.appendTranscript(job, `== job ${state}${error ? `: ${error}` : ''}`);
    // A child reports to the blackboard however it ended. A failure is a
    // finding too — the next child should not spend money rediscovering it.
    this.notify?.jobFinished(job);
    if (job.goal_id && this.goals) {
      try {
        this.goals.appendFinding(job.goal_id, { job, text: job.result_text || job.error || '' });
        if (this.goals.settle(job.goal_id, this.jobs) === 'awaiting_approval') {
          // Unawaited on purpose: this blocks on a human, and finish() is on
          // the job lifecycle path. Errors are contained inside.
          this.superviseGoal(job.goal_id);
        }
      } catch (e) { this.log.warn(`goal ${job.goal_id}: post-finish bookkeeping failed: ${e.message}`); }
    }
    setImmediate(() => this.pump());
  }

  /** Ask whether the held children should run, then act on the answer.
   *
   *  The question is deliberately asked AFTER the read-only wave has reported,
   *  so the decision is made against what those children actually found rather
   *  than against the plan that preceded them. Silence is never approval: an
   *  unanswered question discards the held work, because a fan-out that
   *  proceeds because nobody objected is not supervised, it is merely delayed.
   */
  async superviseGoal(goalId) {
    try {
      const g = this.goals.get(goalId);
      const held = g.pending_jobs || [];
      if (!held.length) return;
      const spent = this.goals.spent(goalId, this.jobs);
      const done = g.job_ids.map(id => this.jobs.get(id)).filter(Boolean);
      const failed = done.filter(j => j.state !== 'completed').length;

      if (!this.asker?.enabled) {
        // No way to ask means no way to approve. Holding is the safe failure.
        this.log.warn(`goal ${goalId}: held ${held.length} job(s) but supervision is not configured — not dispatching`);
        this.notify?.post(`⚠ **${this.goals.label(goalId)}** — ${held.length} job(s) held, but no way to ask for approval. Nothing dispatched.`);
        return;
      }

      const summary = `${done.length} read-only job(s) done${failed ? `, ${failed} failed` : ''} · $${spent.toFixed(2)} spent · ${held.length} change(s) ready`;
      const answer = await this.asker.ask({
        question: `${this.goals.label(goalId)} — run the ${held.length} job(s) that change things? (${summary})`,
        options: ['Go ahead', 'Stop here'],
        timeout_minutes: Number(this.cfg.goals?.approval_timeout_minutes ?? 60),
        context: 'goal approval',
      });

      if (answer.status !== 'answered' || answer.choice === 'Stop here') {
        const why = answer.status === 'answered' ? 'declined' : answer.status;
        const n = this.goals.discardPending(goalId, why);
        this.notify?.post(`◆ **${this.goals.label(goalId)}** stopped — ${n} job(s) not run (${why})`);
        return;
      }

      // Anything other than "Stop here" that was actually answered proceeds,
      // including free text — a person who replies at all has engaged with it.
      const release = this.goals.releasePending(goalId);
      this.notify?.post(`◆ **${this.goals.label(goalId)}** approved — dispatching ${release.length} job(s)`);
      for (const c of release) {
        try {
          await this.start({ ...c, goal_id: goalId, chat_id: g.chat_id });
        } catch (e) {
          this.log.warn(`goal ${goalId}: held job for ${c.project} refused: ${e.message}`);
        }
      }
    } catch (e) {
      this.log.error(`goal ${goalId}: supervision failed (${e.message})`);
    }
  }

  // ---------- run ----------
  async runJob(job) {
    const repoDir = job.project_path;
    const ov = projectOverrides(this.cfg, job.project);
    const remote = await hasRemote(repoDir);
    const wt = path.join(this.cfg.data_dir, 'worktrees', job.id);
    fs.mkdirSync(path.dirname(wt), { recursive: true });

    // Every job runs in a disposable worktree: the project checkout is never
    // touched, so its dirty state can't block a job and concurrent jobs can't
    // collide. Execute jobs branch off the (fetched) base; plan jobs get a
    // detached read-only snapshot.
    if (job.mode === 'execute') {
      const base = job.base_branch || await defaultBranch(repoDir, ov.default_branch);
      job.base_branch = base;
      let startPoint = base;
      if (remote) {
        job.activity = `fetching origin/${base}`;
        this.save(job);
        const r = await run('git', ['fetch', '--quiet', 'origin', base], { cwd: repoDir, timeoutMs: 120_000 });
        if (r.code === 0) startPoint = `origin/${base}`;
        else { job.notes.push(`fetch of origin/${base} failed; branching from local ${base}`); this.appendTranscript(job, `fetch failed: ${r.stderr.trim()}`); }
      }
      if (startPoint === base && !(await branchExists(repoDir, base))) {
        return this.finish(job, 'failed', `base branch ${base} does not exist in ${job.project}`);
      }
      const prefix = this.cfg.claude.branch_prefix || 'bridge/';
      job.branch = `${prefix}${slugify(job.summary)}-${job.id.slice(2, 10)}`;
      try {
        await worktreeAdd(repoDir, wt, { branch: job.branch, startPoint });
      } catch (e) {
        return this.finish(job, 'failed', `could not create worktree for ${job.branch}: ${e.message}`);
      }
      job.worktree = wt;
      this.appendTranscript(job, `created worktree on branch ${job.branch} from ${startPoint}`);
    } else {
      const ref = job.base_branch || 'HEAD';
      try {
        await worktreeAdd(repoDir, wt, { detach: true, ref });
      } catch (e) {
        return this.finish(job, 'failed', `could not create read-only worktree at ${ref}: ${e.message}`);
      }
      job.worktree = wt;
      this.appendTranscript(job, `created read-only worktree at ${ref}`);
    }

    // Build the claude command.
    const args = this.claudeArgs(job, { remote });
    job.activity = 'launching claude';
    this.save(job, { immediate: true });
    this.appendTranscript(job, `exec: claude ${args.filter(a => a !== job.prompt).map(a => a.length > 80 ? trunc(a, 80) : a).join(' ')}`);

    const exit = await this.spawnClaude(job, args);
    if (job.state === 'cancelled' || job._cancelling) return; // cancel() handles cleanup

    if (exit.timedOut) {
      await this.postProcess(job, { remote, abnormal: true });
      return this.finish(job, 'failed', `timed out after ${job.limits.timeout_minutes} minutes (hard limit); partial work kept on ${job.branch || 'no branch'}`);
    }
    if (exit.code !== 0 && !job._resultSeen) {
      await this.postProcess(job, { remote, abnormal: true });
      return this.finish(job, 'failed', `claude exited with code ${exit.code}${exit.lastStderr ? `: ${trunc(exit.lastStderr, 400)}` : ''}`);
    }
    if (job._modelUnrecognized && !job._resultError) job._resultError = `model "${job.model_selected}" (tier ${job.tier}) is not available to this Claude Code login — no fallback attempted`;
    if (job._resultError) {
      await this.postProcess(job, { remote, abnormal: true });
      return this.finish(job, 'failed', job._resultError);
    }
    await this.postProcess(job, { remote, abnormal: false });
    this.finish(job, 'completed');
  }

  claudeArgs(job, { remote }) {
    const c = this.cfg.claude;
    const args = ['-p', job.prompt, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(job.limits.max_cost_usd)];
    if (job.mode === 'plan') {
      args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree');
    } else {
      args.push('--permission-mode', 'bypassPermissions');
    }
    if (job.agent) args.push('--agent', job.agent);
    if (job.model_selected) args.push('--model', job.model_selected);
    // Effort drives adaptive reasoning, and Claude Code defaults it to 'high'.
    // On routine work the thinking tokens dominate wall-clock time, so this is
    // the single biggest latency lever the bridge has — bigger than the model.
    if (job.effort_selected) args.push('--effort', job.effort_selected);
    args.push('--append-system-prompt', this.systemPrompt(job, { remote }));
    if (Array.isArray(c.extra_args)) args.push(...c.extra_args);
    return args;
  }

  systemPrompt(job, { remote }) {
    const lines = [
      `You are running unattended through the Claude Code Bridge (job ${job.id}) in an isolated git worktree of the repository "${job.project}". Nobody can answer questions, so make sensible decisions yourself and state your assumptions in your final message.`,
      `This worktree contains committed state only: untracked files from the project's main checkout (local .env files, node_modules, build output) are absent. If the task needs dependencies to build or test, install them here first; if a local-only file the task needs is missing, say so in your summary instead of guessing.`,
      `Stay inside this worktree. Never print secrets, tokens, or the contents of .env files in your output.`,
      // The budget is enforced by --max-budget-usd, which is a HARD cut the
      // model cannot see coming: 20 jobs ran straight into it and died with
      // nothing to show, $169.71 spent for zero deliverable, every one of them
      // an execute-mode job on the expensive tier. Telling the agent the number
      // converts "cut off mid-thought" into "wrapped up in time".
      `You have a hard budget of $${Number(job.limits.max_cost_usd).toFixed(2)} for this job and a hard limit of ${job.limits.timeout_minutes} minutes. Both are enforced by killing the run — there is no grace period and no partial credit, so a job that spends everything investigating delivers nothing at all. Pace yourself against that: prefer landing a smaller, correct, well-explained result over an exhaustive one you do not finish. If you find yourself running long, stop exploring and write up what you have established, what you changed, and what remains — an honest partial answer is worth far more than being cut off mid-sentence.`,
    ];
    if (job.goal_id && this.goals) {
      const g = this.goals.goals.get(job.goal_id);
      if (g) {
        lines.push(
          `You are one of several agents working towards a shared goal: ${g.objective}`,
          `Your slice of it is the task above. Stay in your own repository — another agent owns each of the others.`,
          `Findings recorded by the agents that ran before you are below. Trust them, do not re-derive them, and do not contradict them without saying why. If none are listed, you are first.`,
          '',
          '--- SHARED FINDINGS ---',
          this.goals.blackboard(job.goal_id),
          '--- END SHARED FINDINGS ---',
          `Your final message is appended to that record for the agents that follow, so write it for them: what you established, what you changed, and what is still unresolved.`,
        );
      }
    }
    if (job.mode === 'plan') {
      lines.push(
        `This is PLAN mode: investigate the codebase and produce a concrete, reviewable implementation plan as your final message — files to touch, the approach, risks, and how to verify.`,
        // Said explicitly because "do not modify any files" was read as "do not
        // change the repo", leaving CREATING a new plan file apparently fair
        // game. Write is not in this job's toolset, so the attempt always
        // fails; 33 plan jobs burned turns discovering that independently, and
        // several spent the discovery a second time after reading that an
        // earlier agent had already hit it.
        `The Edit, Write and NotebookEdit tools are NOT available to you in this job — not restricted, absent. Do not attempt to create, write or save ANY file, including a plan document, a scratch file, or notes: every such call will fail and the turn is wasted. Do not create branches or commits either.`,
        `Your final message IS the deliverable. The bridge captures it verbatim and saves it as the plan file on your behalf, so anything you would have written to disk belongs in that message instead.`,
      );
    } else {
      lines.push(
        `This is EXECUTE mode. You are on branch "${job.branch}" (created from "${job.base_branch}"). Rules: stay on this branch; do not checkout, merge, rebase, reset --hard, push, or force-push anything — the bridge pushes and opens a draft PR afterwards. Commit your work in logical commits with clear messages; leave the working tree clean when you finish.`,
        remote ? `A remote exists; a human will review the PR, so write commit messages and a final summary that a reviewer can follow.` : `There is no remote; the branch stays local and a human will review it there.`,
      );
      if (job.setup?.preflight) lines.push(`Before finishing, work through the checklist in .claude/preflight.md and fix anything it catches that relates to your change.`);
      lines.push(`Finish with a concise summary: what changed, how you verified it, and anything the reviewer should know.`);
    }
    return lines.join('\n');
  }

  spawnClaude(job, args) {
    return new Promise(resolve => {
      const dir = job.worktree || job.project_path;
      const bin = this.cfg.claude.bin || 'claude';
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb',
        SHELL: process.env.SHELL || '/bin/bash',
        // Claude Code refuses bypassPermissions as root unless it believes it's sandboxed.
        IS_SANDBOX: '1',
        GIT_TERMINAL_PROMPT: '0',
        CLAUDE_CODE_BRIDGE_JOB: job.id,
      };
      // Subagents INHERIT the parent model unless told otherwise, so a
      // codebase sweep under an Opus job does grep-shaped work at Opus latency.
      // This env var beats both the Agent tool's model parameter and agent
      // frontmatter, which is what makes it reliable here.
      if (this.cfg.claude.subagent_model) env.CLAUDE_CODE_SUBAGENT_MODEL = this.cfg.claude.subagent_model;
      // Nobody is watching an unattended job, so background/non-essential
      // model calls are pure added latency and spend.
      if (this.cfg.claude.disable_nonessential_traffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      // Only the failover attempt carries a key. Ordinary jobs run on the
      // subscription (flat rate); passing the key always would bill every job
      // per token, which is the opposite of what this is for.
      if (job.failover_used && this.cfg.failover?.api_key) {
        env.ANTHROPIC_API_KEY = this.cfg.failover.api_key;
      }
      const streamFile = fs.openSync(path.join(this.jobDir(job.id), 'stream.jsonl'), 'a');
      let child;
      try {
        child = spawn(bin, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        fs.closeSync(streamFile);
        return resolve({ code: -1, lastStderr: e.message });
      }
      job.pid = child.pid;
      this.save(job, { immediate: true });
      const timeoutMs = job.limits.timeout_minutes * 60_000;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.killTree(job); }, timeoutMs);
      this.procs.set(job.id, { child, timer });

      let buf = '';
      let lastStderr = '';
      child.stdout.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const safe = scrub(line);
          try { fs.writeSync(streamFile, safe + '\n'); } catch { /* ignore */ }
          this.handleEvent(job, line);
        }
      });
      child.stderr.on('data', chunk => {
        const s = scrub(String(chunk));
        lastStderr = (lastStderr + s).slice(-2000);
        if (/unrecognized_model/.test(s)) job._modelUnrecognized = true;
        for (const l of s.split('\n')) if (l.trim()) this.appendTranscript(job, `stderr: ${trunc(l, 300)}`);
      });
      child.on('error', e => { lastStderr += e.message; });
      child.on('close', code => {
        clearTimeout(timer);
        if (buf.trim()) { try { fs.writeSync(streamFile, scrub(buf) + '\n'); } catch { /* ignore */ } this.handleEvent(job, buf); }
        fs.closeSync(streamFile);
        this.procs.delete(job.id);
        job.pid = null;
        resolve({ code, timedOut, lastStderr: lastStderr.trim().split('\n').slice(-3).join(' | ') });
      });
    });
  }

  killTree(job) {
    const p = this.procs.get(job.id);
    const pid = p?.child?.pid || job.pid;
    if (!pid) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }, 5000).unref();
  }

  handleEvent(job, line) {
    let ev;
    try { ev = JSON.parse(line); } catch { this.appendTranscript(job, `raw: ${trunc(line, 300)}`); return; }
    const t = ev.type;
    if (t === 'system' && ev.subtype === 'init') {
      job.session_id = ev.session_id || job.session_id;
      job.model = ev.model || job.model;
      if (job.model_selected && job.model && job.model !== job.model_selected) job.notes.push(`model mismatch: requested ${job.model_selected}, session reports ${job.model}`);
      job.activity = `session started (${job.model || 'model?'})`;
      this.appendTranscript(job, `>> session ${job.session_id} started, model=${job.model}, tools=${Array.isArray(ev.tools) ? ev.tools.length : '?'}${ev.permissionMode ? `, permissions=${ev.permissionMode}` : ''}`);
    } else if (t === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          job.activity = `writing: ${trunc(block.text.replace(/\s+/g, ' ').trim(), 90)}`;
          this.appendTranscript(job, `TEXT ${block.text.trim()}`);
        } else if (block.type === 'tool_use') {
          const d = describeToolUse(block);
          job.activity = `tool ${d}`;
          this.appendTranscript(job, `TOOL ${d}`);
        }
      }
      if (ev.message.usage) job.usage = accumulateUsage(job.usage, ev.message.usage);
    } else if (t === 'user' && ev.message?.content) {
      for (const block of Array.isArray(ev.message.content) ? ev.message.content : []) {
        if (block.type === 'tool_result') {
          const txt = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : '';
          const first = txt.trim().split('\n')[0] || '';
          this.appendTranscript(job, `  -> ${block.is_error ? 'ERROR ' : ''}result (${txt.length} chars)${first ? `: ${trunc(first, 160)}` : ''}`);
        }
      }
    } else if (t === 'result') {
      job._resultSeen = true;
      job.cost_usd = typeof ev.total_cost_usd === 'number' ? Math.round(ev.total_cost_usd * 10000) / 10000 : job.cost_usd;
      job.num_turns = ev.num_turns ?? job.num_turns;
      if (ev.usage) job.usage = { ...(job.usage || {}), ...pickUsage(ev.usage) };
      job.result_text = scrub(typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? ''));
      if (ev.is_error && /issue with the selected model|unrecognized.?model|model.*not.?found|does not exist or you do not have access/i.test(job.result_text || '')) {
        job._resultError = `model "${job.model_selected}" (tier ${job.tier}) is not available to this Claude Code login — no fallback attempted; fix models.tiers in config.json or pass model=`;
      } else if (ev.is_error) job._resultError = `claude reported an error (${ev.subtype || 'error'}): ${trunc(job.result_text || '', 500)}`;
      else if (ev.subtype && ev.subtype !== 'success') job.notes.push(`result subtype: ${ev.subtype}`);
      if (ev.subtype === 'error_max_budget_usd' || /max.?budget/i.test(ev.subtype || '')) job._resultError = `cost ceiling of $${job.limits.max_cost_usd} reached (spent $${job.cost_usd}); job stopped`;
      if (job.mode === 'plan' && job.result_text) {
        const pf = path.join(this.jobDir(job.id), 'plan.md');
        try { fs.writeFileSync(pf, job.result_text + '\n'); job.plan_file = pf; } catch { /* ignore */ }
      }
      this.appendTranscript(job, `RESULT cost=$${job.cost_usd ?? '?'} turns=${job.num_turns ?? '?'} duration=${Math.round((ev.duration_ms || 0) / 1000)}s subtype=${ev.subtype || ''}`);
    }
    this.save(job);
  }

  // ---------- after claude exits ----------
  async postProcess(job, { remote, abnormal }) {
    if (job.mode !== 'execute' || !job.branch || !job.worktree) {
      await this.removeWorktree(job);
      return;
    }
    const dir = job.worktree; // all git work happens in the job's worktree
    try {
      // Commit anything the agent left uncommitted so nothing is lost.
      const st = await workingTreeStatus(dir, { timeoutMs: 60_000 });
      if (st.dirty) {
        job.activity = 'committing leftover changes';
        await git(['add', '-A'], { cwd: dir, timeoutMs: 60_000 });
        await git(['-c', `user.name=${authorName(this.cfg)}`, '-c', `user.email=${authorEmail(this.cfg)}`, 'commit', '--quiet', '-m', `chore(bridge): ${abnormal ? 'partial work' : 'leftover changes'} from job ${job.id}\n\n${trunc(job.summary, 200)}`], { cwd: dir, timeoutMs: 60_000 });
        job.notes.push(`bridge committed ${st.entries.length} leftover change(s) the agent left uncommitted`);
        this.appendTranscript(job, `committed ${st.entries.length} leftover change(s)`);
      }
      const base = job.base_branch;
      const baseRef = remote ? `origin/${base}` : base;
      let baseSha;
      try { baseSha = (await git(['rev-parse', '--verify', '--quiet', baseRef], { cwd: dir })).trim(); } catch { baseSha = (await git(['rev-parse', '--verify', '--quiet', base], { cwd: dir })).trim(); }
      const count = Number((await git(['rev-list', '--count', `${baseSha}..HEAD`], { cwd: dir })).trim());
      job.commits = count;

      if (count === 0) {
        job.notes.push('no commits were produced; branch removed');
        this.appendTranscript(job, 'no commits on branch; removing it');
        // The branch can only be deleted once no worktree has it checked out.
        await this.removeWorktree(job);
        await run('git', ['branch', '-D', job.branch], { cwd: job.project_path });
        job.branch = null;
        return;
      }

      if (remote) {
        job.activity = `pushing ${job.branch}`;
        this.save(job);
        const r = await run('git', ['push', '--quiet', '-u', 'origin', `${job.branch}:${job.branch}`], { cwd: dir, timeoutMs: 180_000 });
        if (r.code === 0) {
          job.pushed = true;
          this.appendTranscript(job, `pushed ${job.branch} to origin`);
          await this.openDraftPr(job);
        } else {
          job.pushed = false;
          job.notes.push(`push failed: ${trunc(r.stderr.trim(), 300)} — branch exists locally`);
          this.appendTranscript(job, `push failed: ${r.stderr.trim()}`);
        }
      } else {
        job.pushed = false;
        job.notes.push(`no remote configured; ${count} commit(s) on local branch ${job.branch}`);
      }
    } catch (e) {
      job.notes.push(`post-processing error: ${scrub(e.message)}`);
      this.appendTranscript(job, `post-processing error: ${e.message}`);
    } finally {
      await this.removeWorktree(job);
      this.save(job, { immediate: true });
    }
  }

  /** Remove a job's worktree (idempotent; the branch and its commits survive in the repo). */
  async removeWorktree(job) {
    if (!job.worktree) return;
    const wt = job.worktree;
    await worktreeDiscard(job.project_path, wt);
    job.worktree = null;
    this.appendTranscript(job, `removed worktree`);
  }

  async openDraftPr(job) {
    const dir = job.project_path;
    const url = remoteUrlFast(dir);
    const parsed = parseRemote(url);
    const hc = parsed ? hostConfigFor(this.cfg, parsed.host) : null;
    if (!parsed || !hc) {
      job.notes.push(parsed ? `branch pushed; host ${parsed.host} isn't in clone.hosts, so no PR was opened — open it manually` : `branch pushed; remote is not a recognised git host (local path?), so no PR was opened`);
      return;
    }
    const title = trunc(job.summary, 70);
    const body = [
      `Draft PR opened by Claude Code Bridge (job \`${job.id}\`).`, '',
      '**Task**', '', '```', trunc(job.prompt, 2000), '```', '',
      '**Agent summary**', '', trunc(job.result_text || '(none)', 6000), '',
      `Session: \`${job.session_id || '?'}\` · model: ${job.model || '?'} · cost: $${job.cost_usd ?? '?'} · Not merged automatically — human review required.`,
    ].join('\n');
    job.activity = 'opening draft PR';
    this.save(job);
    try {
      let res, prUrl;
      if (hc.type === 'github') {
        res = await apiFetch(hc, `/repos/${parsed.owner}/${parsed.repo}/pulls`, { method: 'POST', body: { title, head: job.branch, base: job.base_branch, body, draft: true } });
        prUrl = res.json?.html_url;
      } else if (hc.type === 'gitea') {
        res = await apiFetch(hc, `/repos/${parsed.owner}/${parsed.repo}/pulls`, { method: 'POST', body: { title: `WIP: ${title}`, head: job.branch, base: job.base_branch, body } });
        prUrl = res.json?.html_url;
      } else if (hc.type === 'gitlab') {
        const id = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
        res = await apiFetch(hc, `/projects/${id}/merge_requests`, { method: 'POST', body: { title: `Draft: ${title}`, source_branch: job.branch, target_branch: job.base_branch, description: body } });
        prUrl = res.json?.web_url;
      } else {
        job.notes.push(`host type ${hc.type} unsupported for PR creation; branch pushed`);
        return;
      }
      if (res.ok && prUrl) {
        job.pr_url = prUrl;
        this.appendTranscript(job, `opened draft PR ${prUrl}`);
      } else {
        job.notes.push(`PR creation failed (${res.status}): ${trunc(scrub(res.json?.message || res.json?.errors?.[0]?.message || res.text), 300)} — branch is pushed`);
      }
    } catch (e) {
      job.notes.push(`PR creation error: ${scrub(e.message)} — branch is pushed`);
    }
  }

  // ---------- compose redeploy (async job) ----------
  async startComposeRedeploy({ project, file, services, profile, no_cache = false, remove_orphans = false, timeout_minutes }) {
    const target = resolveComposeTarget(this.cfg, project, { file, profile });
    if (target.protectedBy) throw new Error(`refused: ${target.protectedBy}. Use a terminal on the box for this stack.`);
    const svc = validateServices(services);
    this.assertComposeFree(target.project, 'a compose redeploy');
    const id = newJobId();
    const job = {
      id, kind: 'compose_redeploy', project: target.project, project_path: target.dir, mode: 'redeploy', agent: null,
      prompt: `compose redeploy ${target.files.join(',')}${svc.length ? ` [${svc.join(',')}]` : ''}`,
      summary: `compose redeploy ${target.project}${svc.length ? ` (${svc.join(', ')})` : ''}${no_cache ? ' --no-cache' : ''}`,
      state: 'queued', created_at: nowIso(), started_at: null, finished_at: null, activity: 'queued',
      compose: { file: file || null, files: target.files, profile: profile || null, services: svc, no_cache: !!no_cache, remove_orphans: !!remove_orphans, project_name: null, steps: [], before: null, after: null, current_step: null },
      error: null, notes: [], pid: null,
      limits: { timeout_minutes: timeout_minutes ?? this.cfg.compose?.redeploy_timeout_minutes ?? 15 },
    };
    fs.mkdirSync(this.jobDir(id), { recursive: true });
    this.jobs.set(id, job);
    this.save(job, { immediate: true });
    this.appendTranscript(job, `job ${id} queued: ${job.summary}`);
    setImmediate(() => this.pump());
    return { job_id: id, state: job.state, project: target.project, files: target.files, services: svc, limits: job.limits };
  }

  async runComposeJob(job) {
    const c = job.compose;
    const target = resolveComposeTarget(this.cfg, job.project, { file: c.file, profile: c.profile });
    job._target = target;
    const deadline = Date.now() + job.limits.timeout_minutes * 60_000;
    const holder = {}; job._composeHolder = holder;
    const line = l => this.appendTranscript(job, l);
    const step = async (name, args, { skip = false } = {}) => {
      if (skip) { c.steps.push({ name, state: 'skipped' }); return true; }
      if (job._cancelled) return false;
      c.current_step = name; job.activity = `compose ${name}`; this.save(job, { immediate: true });
      line(`== ${name}: docker compose ${args.join(' ')}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) { c.steps.push({ name, state: 'not started (timed out)' }); return false; }
      const t0 = Date.now();
      const r = await composeStream(target, args, { onLine: line, timeoutMs: remaining, signalHolder: holder });
      const entry = { name, state: r.timedOut ? 'timed out' : r.code === 0 ? 'ok' : `exit ${r.code}`, seconds: Math.round((Date.now() - t0) / 1000) };
      c.steps.push(entry);
      this.save(job);
      if (r.timedOut) { job._timedOutStep = name; return false; }
      return r.code === 0;
    };
    try {
      const cfgInfo = await composeConfig(target);
      c.project_name = cfgInfo.name;
      const prot = isProtected(this.cfg, job.project, cfgInfo.name);
      if (prot) return this.finish(job, 'failed', `refused: ${prot}`);
      const targeted = c.services.length ? cfgInfo.services.filter(s => c.services.includes(s.name)) : cfgInfo.services;
      const unknown = c.services.filter(n => !cfgInfo.services.some(s => s.name === n));
      if (unknown.length) return this.finish(job, 'failed', `unknown service(s): ${unknown.join(', ')} (available: ${cfgInfo.services.map(s => s.name).join(', ')})`);
      c.before = await composeStatus(target, c.services);
      line(`before: ${summarise(c.before)}`);
      const hasBuild = targeted.some(s => s.build);
      const hasImage = targeted.some(s => !s.build);
      let ok = await step('pull', ['pull', '--ignore-buildable', ...c.services], { skip: !hasImage });
      if (ok) ok = await step('build', ['build', '--pull', ...(c.no_cache ? ['--no-cache'] : []), ...c.services], { skip: !hasBuild });
      if (ok) ok = await step('up', ['up', '-d', '--no-build', ...(c.remove_orphans ? ['--remove-orphans'] : []), ...c.services]);
      c.current_step = null;
      try { c.after = await composeStatus(target, c.services); line(`after: ${summarise(c.after)}`); } catch (e) { job.notes.push(`could not read post-run status: ${scrub(e.message)}`); }
      if (job._cancelled) return; // cancel() finishes the job
      if (job._timedOutStep) return this.finish(job, 'failed', `timed out after ${job.limits.timeout_minutes} min during "${job._timedOutStep}"; partial state recorded in compose.before/after (steps: ${c.steps.map(s => `${s.name}=${s.state}`).join(', ')})`);
      if (!ok) { const bad = c.steps.find(s => /exit/.test(s.state)); return this.finish(job, 'failed', `step "${bad?.name}" failed (${bad?.state}); see log. Steps: ${c.steps.map(s => `${s.name}=${s.state}`).join(', ')}`); }
      job.result_text = `redeploy ok: ${c.steps.map(s => `${s.name}=${s.state}`).join(', ')}\nbefore: ${summarise(c.before)}\nafter: ${summarise(c.after)}`;
      this.finish(job, 'completed');
    } catch (e) {
      try { c.after = await composeStatus(target, c.services); } catch { /* ignore */ }
      this.finish(job, 'failed', `compose redeploy error: ${scrub(e.message)}`);
    }
  }

  // ---------- cancel ----------
  async cancel(id, { keep_branch = false } = {}) {
    const job = this.get(id);
    if (!ACTIVE.has(job.state)) return { job_id: id, state: job.state, message: `job is already ${job.state}` };
    if (job.state === 'queued') {
      this.finish(job, 'cancelled', 'cancelled before start');
      return { job_id: id, state: 'cancelled', message: 'removed from queue' };
    }
    job._cancelling = true;
    job.activity = 'cancelling';
    this.save(job, { immediate: true });
    this.appendTranscript(job, 'cancel requested');
    const p = this.procs.get(id);
    if (p) {
      clearTimeout(p.timer);
      const exited = new Promise(res => p.child.once('close', res));
      this.killTree(job);
      await Promise.race([exited, new Promise(r => setTimeout(r, 8000))]);
    }
    if (job.kind === 'compose_redeploy') {
      job._cancelled = true;
      const stepAtCancel = job.compose.current_step || '?';
      if (job._composeHolder?.child) composeKill(job._composeHolder.child.pid);
      await new Promise(r => setTimeout(r, 1500));
      try { job.compose.after = await composeStatus(job._target || resolveComposeTarget(this.cfg, job.project, { file: job.compose.file, profile: job.compose.profile }), job.compose.services); } catch (e) { job.notes.push(`could not read post-cancel status: ${scrub(e.message)}`); }
      this.finish(job, 'cancelled', `cancelled during step "${stepAtCancel}"; see compose.after for the resulting state`);
      return { job_id: id, state: 'cancelled', cleanup: ['compose process terminated; containers left in whatever state the interrupted step produced (see get_task_status compose.after)'] };
    }
    const cleanup = [];
    if (job.mode === 'execute' && job.branch) {
      try {
        if (keep_branch && job.worktree) {
          const st = await workingTreeStatus(job.worktree, { timeoutMs: 60_000 });
          if (st.dirty) {
            await git(['add', '-A'], { cwd: job.worktree });
            await git(['-c', `user.name=${authorName(this.cfg)}`, '-c', `user.email=${authorEmail(this.cfg)}`, 'commit', '--quiet', '-m', `chore(bridge): partial work from cancelled job ${job.id}`], { cwd: job.worktree });
            cleanup.push('committed partial work');
          }
          cleanup.push(`kept branch ${job.branch}`);
          await this.removeWorktree(job);
        } else {
          // Uncommitted agent output lives only in the worktree; removing it discards nothing else.
          await this.removeWorktree(job);
          const r = await run('git', ['branch', '-D', job.branch], { cwd: job.project_path });
          if (r.code === 0) { cleanup.push(`deleted branch ${job.branch}`); job.branch = null; }
          else cleanup.push(`could not delete branch ${job.branch}: ${trunc(r.stderr.trim(), 200)}`);
          cleanup.push('discarded worktree with uncommitted changes');
        }
      } catch (e) {
        cleanup.push(`cleanup error: ${scrub(e.message)}`);
      }
    }
    await this.removeWorktree(job).catch(() => {}); // plan-mode worktrees
    job.notes.push(...cleanup);
    this.finish(job, 'cancelled', 'cancelled by request');
    return { job_id: id, state: 'cancelled', cleanup };
  }

  /** Kill all running children (server shutdown). Jobs are marked interrupted on next init(). */
  shutdown() {
    for (const job of this.jobs.values()) if (job._composeHolder?.child) composeKill(job._composeHolder.child.pid);
    for (const [id] of this.procs) { const job = this.jobs.get(id); if (job) { this.killTree(job); job.state = 'interrupted'; job.finished_at = nowIso(); job.error = 'server shut down while the job was running'; this.save(job, { immediate: true }); } }
  }
}

function summarise(list) {
  if (!Array.isArray(list)) return '(unknown)';
  if (!list.length) return '(no containers)';
  return list.map(c => `${c.service}=${c.state}${c.health ? `/${c.health}` : ''}`).join(' ');
}

function elapsedSeconds(j) {
  const start = j.started_at || j.created_at;
  const end = j.finished_at || nowIso();
  return Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
}

function describeToolUse(block) {
  const inp = block.input || {};
  const name = block.name;
  let detail = '';
  if (name === 'Bash') detail = inp.command;
  else if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) detail = inp.file_path || inp.path;
  else if (name === 'Grep') detail = `${inp.pattern}${inp.path ? ` in ${inp.path}` : ''}`;
  else if (name === 'Glob') detail = inp.pattern;
  else if (name === 'Task' || name === 'Agent') detail = inp.description || inp.prompt;
  else if (name === 'WebFetch') detail = inp.url;
  else if (name === 'TodoWrite') detail = `${(inp.todos || []).length} items`;
  else detail = JSON.stringify(inp);
  return `${name}: ${trunc(String(detail ?? '').replace(/\s+/g, ' '), 160)}`;
}

function pickUsage(u) {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}
function accumulateUsage(acc, u) {
  const p = pickUsage(u);
  if (!acc) return p;
  return {
    input_tokens: (acc.input_tokens || 0) + p.input_tokens,
    output_tokens: (acc.output_tokens || 0) + p.output_tokens,
    cache_creation_input_tokens: (acc.cache_creation_input_tokens || 0) + p.cache_creation_input_tokens,
    cache_read_input_tokens: (acc.cache_read_input_tokens || 0) + p.cache_read_input_tokens,
  };
}
function authorName(cfg) { return (cfg.claude.commit_author || 'Claude Code Bridge <bridge@localhost>').replace(/\s*<.*$/, ''); }
function authorEmail(cfg) { const m = (cfg.claude.commit_author || '').match(/<([^>]+)>/); return m ? m[1] : 'claude-code-bridge@localhost'; }
