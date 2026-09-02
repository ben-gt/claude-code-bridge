// Goals: one objective, many jobs, across many projects.
//
// A goal is a parent record that owns child jobs and a shared blackboard. It
// exists because the interesting unit of work is "get passkeys running on every
// portal", not "run this prompt in bnd-flux" — and because the useful budget is
// the one that covers the whole fan-out, not each child separately. Eight jobs
// under a $20 per-job ceiling is a $160 goal; nothing in the per-job limits
// notices that.
//
// Children do NOT talk to each other. They read the blackboard when they start
// and append to it when they finish. That costs no tokens, cannot drift, and
// survives a bridge restart — and unlike agent-to-agent chatter it leaves a
// readable account of who concluded what, in order.
//
// Storage mirrors jobs/: one directory per goal under data_dir/goals/<id>/,
// holding goal.json and blackboard.md. Jobs keep their own records and simply
// carry a goal_id, so nothing here is load-bearing for an ordinary job.

import fs from 'node:fs';
import path from 'node:path';

export const GOAL_STATES = ['active', 'completed', 'cancelled', 'exhausted'];

const nowIso = () => new Date().toISOString();
const trunc = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + `\n…[truncated at ${n} chars]` : String(s || ''));

function newId() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class GoalManager {
  constructor(cfg, { log = console, notify = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.notify = notify;
    this.dir = path.join(cfg.data_dir, 'goals');
    fs.mkdirSync(this.dir, { recursive: true });
    this.goals = new Map();
  }

  goalDir(id) { return path.join(this.dir, id); }
  recordFile(id) { return path.join(this.goalDir(id), 'goal.json'); }
  blackboardFile(id) { return path.join(this.goalDir(id), 'blackboard.md'); }

  init() {
    let loaded = 0;
    for (const id of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      try {
        this.goals.set(id, JSON.parse(fs.readFileSync(this.recordFile(id), 'utf8')));
        loaded++;
      } catch { /* skip corrupt */ }
    }
    this.log.info(`goals: loaded ${loaded} record(s)`);
  }

  save(goal) {
    fs.mkdirSync(this.goalDir(goal.id), { recursive: true });
    const tmp = this.recordFile(goal.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(goal, null, 2));
    fs.renameSync(tmp, this.recordFile(goal.id));
  }

  get(id) {
    const g = this.goals.get(id);
    if (!g) throw new Error(`goal ${id} is not a known goal`);
    return g;
  }

  create({ objective, budget_usd, chat_id }) {
    const budget = Number(budget_usd ?? this.cfg.goals?.budget_usd ?? 25);
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('budget_usd must be a positive number');
    const goal = {
      id: newId(),
      objective: String(objective || '').trim(),
      state: 'active',
      budget_usd: budget,
      job_ids: [],
      chat_id: chat_id || null,
      created_at: nowIso(),
      finished_at: null,
    };
    if (!goal.objective) throw new Error('objective is required');
    fs.mkdirSync(this.goalDir(goal.id), { recursive: true });
    fs.writeFileSync(this.blackboardFile(goal.id),
      `# Goal ${goal.id}\n\n${goal.objective}\n\n---\n\n_No findings recorded yet._\n`);
    this.goals.set(goal.id, goal);
    this.save(goal);
    return goal;
  }

  /** Human label for a goal: the objective's first clause, not its id. */
  label(goalId) {
    const g = this.goals.get(goalId);
    if (!g) return null;
    const first = String(g.objective || '').replace(/\s+/g, ' ')
      .split(/(?<=[.;:])\s/)[0].replace(/[.;:,]\s*$/, '').trim();
    return first ? (first.length > 60 ? first.slice(0, 60).trim() + '\u2026' : first) : null;
  }

  attach(goalId, jobId) {
    const g = this.get(goalId);
    if (!g.job_ids.includes(jobId)) {
      g.job_ids.push(jobId);
      this.save(g);
    }
    return g;
  }

  /** Blackboard as the children see it. Capped so a long-running goal cannot
   *  quietly become the largest thing in every child's prompt. */
  blackboard(goalId, { max = 20000 } = {}) {
    try {
      const all = fs.readFileSync(this.blackboardFile(goalId), 'utf8');
      if (all.length <= max) return all;
      // Keep the TAIL, not the head. Findings are appended, so head-truncation
      // drops the newest ones — exactly the entries a starting child most needs
      // — while faithfully preserving the objective and the oldest notes. One
      // goal's board reached 31,452 chars against this cap, so later children
      // were reading history and missing everything recent.
      const head = all.slice(0, all.indexOf('---') + 4) || '';
      const tail = all.slice(-(max - head.length - 80));
      return `${head}\n_[earlier findings trimmed — newest kept]_\n${tail.slice(tail.indexOf('\n## ') + 1 || 0)}`;
    } catch { return ''; }
  }

  /** Append one child's findings. Called from the job lifecycle, never by the
   *  model directly — a child cannot rewrite what an earlier child concluded. */
  appendFinding(goalId, { job, text }) {
    const g = this.goals.get(goalId);
    if (!g) return;
    // Strip harness apologies before they reach the board. A denied tool
    // produces a paragraph explaining that the tool was denied, which becomes
    // the FIRST line of the finding, is prepended verbatim to every later
    // child, and displaces genuine findings under the size cap — three agents
    // in a row re-reported the same denial because each read the last one's
    // apology. It is a fact about the harness, not about the work.
    const body = String(text || '')
      .replace(/^[^\n]*\b(write|edit|notebookedit)\b[^\n]*\b(tool|is)\b[^\n]*\b(not available|disabled|denied|blocked)\b[^\n]*\n?/gim, '')
      .replace(/^[^\n]*\bplan file (could not|cannot) be (created|written)\b[^\n]*\n?/gim, '')
      .trim();
    const entry = [
      `\n## ${job.project} — ${job.state} (${job.id})`,
      `_${nowIso()}_${job.branch ? ` · branch \`${job.branch}\`` : ''}${job.pr_url ? ` · ${job.pr_url}` : ''}`,
      '',
      body ? trunc(body, 6000) : '_(no summary returned)_',
      '',
    ].join('\n');
    try {
      const f = this.blackboardFile(goalId);
      let cur = '';
      try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
      cur = cur.replace('_No findings recorded yet._\n', '');
      fs.writeFileSync(f, cur + entry);
    } catch (e) {
      this.log.warn(`goal ${goalId}: could not append finding: ${e.message}`);
    }
  }

  /** Spend across every child. The number the budget is actually about. */
  spent(goalId, jobsById) {
    const g = this.goals.get(goalId);
    if (!g) return 0;
    let total = 0;
    for (const id of g.job_ids) total += Number(jobsById.get(id)?.cost_usd || 0);
    return Math.round(total * 10000) / 10000;
  }

  /** Whether another child may be dispatched. Checked before spending, not
   *  after — a goal that has already blown its budget must not start a ninth
   *  job to discover that. */
  canDispatch(goalId, jobsById) {
    const g = this.get(goalId);
    if (g.state !== 'active') return { ok: false, why: `goal is ${g.state}` };
    const spent = this.spent(goalId, jobsById);
    if (spent >= g.budget_usd) {
      if (g.state === 'active') { g.state = 'exhausted'; g.finished_at = nowIso(); this.save(g); }
      return { ok: false, why: `goal budget spent ($${spent.toFixed(2)} of $${g.budget_usd.toFixed(2)})` };
    }
    return { ok: true, remaining: Math.round((g.budget_usd - spent) * 100) / 100 };
  }

  status(goalId, jobsById) {
    const g = this.get(goalId);
    const jobs = g.job_ids.map(id => jobsById.get(id)).filter(Boolean);
    const by = s => jobs.filter(j => j.state === s).length;
    return {
      goal_id: g.id,
      objective: g.objective,
      state: g.state,
      budget_usd: g.budget_usd,
      spent_usd: this.spent(goalId, jobsById),
      counts: {
        queued: by('queued'), running: by('running'), completed: by('completed'),
        failed: by('failed'), cancelled: by('cancelled'), interrupted: by('interrupted'),
      },
      jobs: jobs.map(j => ({
        job_id: j.id, project: j.project, state: j.state, mode: j.mode,
        model: j.model_selected, effort: j.effort_selected || undefined,
        cost_usd: j.cost_usd ?? undefined, branch: j.branch || undefined, pr_url: j.pr_url || undefined,
        summary: j.summary,
      })),
      blackboard: this.blackboard(goalId, { max: 8000 }),
    };
  }

  /** Close a goal once nothing is left to run. Called after each child ends. */
  settle(goalId, jobsById) {
    const g = this.goals.get(goalId);
    if (!g || g.state !== 'active' || !g.job_ids.length) return;
    const jobs = g.job_ids.map(id => jobsById.get(id)).filter(Boolean);
    if (jobs.some(j => j.state === 'queued' || j.state === 'running')) return;
    g.state = 'completed';
    g.finished_at = nowIso();
    this.save(g);
    const spent = this.spent(goalId, jobsById);
    this.log.info(`goal ${g.id} completed: ${jobs.length} job(s), $${spent.toFixed(2)}`);
    try { this.notify?.goalFinished(g, { counts: this.status(goalId, jobsById).counts, spent }); } catch { /* never fail on bookkeeping */ }
  }

  cancel(goalId) {
    const g = this.get(goalId);
    if (g.state === 'active') { g.state = 'cancelled'; g.finished_at = nowIso(); this.save(g); }
    return g;
  }
}
