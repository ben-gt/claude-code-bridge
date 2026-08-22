// Job manager: queueing, running Claude Code headless, stream parsing, persistence,
// branch/PR handling, cancellation and restart recovery.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveProjectDir, BoundaryError } from './paths.js';
import { projectOverrides } from './config.js';
import { detectClaudeSetup } from './projects.js';
import { git, run, defaultBranch, workingTreeStatus, hasRemote, branchExists, remoteUrlFast, parseRemote, currentBranchFast, GitError } from './git.js';
import { scrub, scrubDeep } from './scrub.js';
import { apiFetch, hostConfigFor } from './credentials.js';

export const STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
const ACTIVE = new Set(['queued', 'running']);

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
  constructor(cfg, projectIndex, { log = console } = {}) {
    this.cfg = cfg;
    this.projects = projectIndex;
    this.log = log;
    this.jobsDir = path.join(cfg.data_dir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.jobs = new Map();      // id -> record
    this.procs = new Map();     // id -> { child, timer }
    this.writeTimers = new Map();
  }

  // ---------- persistence ----------
  recordFile(id) { return path.join(this.jobsDir, id, 'job.json'); }
  jobDir(id) { return path.join(this.jobsDir, id); }

  save(job, { immediate = false } = {}) {
    const write = () => {
      this.writeTimers.delete(job.id);
      try { atomicWrite(this.recordFile(job.id), JSON.stringify(job, null, 2)); } catch (e) { this.log.error(`save ${job.id}: ${e.message}`); }
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
          job.error = job.error || 'server restarted while the job was active; working tree left as-is for inspection';
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
        job_id: j.id, state: j.state, project: j.project, mode: j.mode, created_at: j.created_at,
        elapsed_seconds: elapsedSeconds(j), summary: j.summary, branch: j.branch || undefined, pr_url: j.pr_url || undefined,
        cost_usd: j.cost_usd ?? undefined, error: j.error || undefined,
      }));
  }

  status(id) {
    const j = this.get(id);
    return scrubDeep({
      job_id: j.id, state: j.state, project: j.project, mode: j.mode, agent: j.agent || undefined,
      created_at: j.created_at, started_at: j.started_at || undefined, finished_at: j.finished_at || undefined,
      elapsed_seconds: elapsedSeconds(j), activity: j.activity,
      base_branch: j.base_branch || undefined, branch: j.branch || undefined, original_branch: j.original_branch || undefined,
      commits: j.commits ?? undefined, pushed: j.pushed ?? undefined, pr_url: j.pr_url || undefined,
      session_id: j.session_id || undefined, model: j.model || undefined,
      cost_usd: j.cost_usd ?? undefined, usage: j.usage || undefined, num_turns: j.num_turns ?? undefined,
      limits: j.limits,
      result: j.result_text ? trunc(j.result_text, 6000) : undefined,
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

  activeForProject(project) {
    return [...this.jobs.values()].find(j => j.project === project && ACTIVE.has(j.state));
  }

  // ---------- start ----------
  async start({ project, prompt, agent, base_branch, mode = 'plan', max_cost_usd, timeout_minutes }) {
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
    const busy = this.activeForProject(name);
    if (busy) throw new Error(`project ${name} already has an active job (${busy.id}, ${busy.state}); one job per project`);

    // Refuse a dirty tree before anything else (and before Claude is ever invoked).
    const st = await workingTreeStatus(dir, { includeUntracked: !ov.allow_untracked, timeoutMs: 20_000 });
    if (st.dirty) {
      const e = new Error(`refused: ${name} has uncommitted changes (${st.entries.length} entr${st.entries.length === 1 ? 'y' : 'ies'}). Commit or stash them first.\n` + st.entries.slice(0, 20).join('\n'));
      e.code = 'DIRTY_TREE';
      throw e;
    }
    if (!currentBranchFast(dir) && mode === 'execute') {
      // Detached HEAD is fine for plan mode; for execute we need a base to branch from.
      const def = await defaultBranch(dir, ov.default_branch);
      if (!def) throw new Error(`${name} is on a detached HEAD and no default branch could be inferred`);
    }

    const limits = {
      timeout_minutes: timeout_minutes ?? ov.job_timeout_minutes ?? this.cfg.limits.job_timeout_minutes,
      max_cost_usd: max_cost_usd ?? ov.max_cost_usd ?? this.cfg.limits.max_cost_usd,
    };
    const id = newJobId();
    const job = {
      id, project: name, project_path: dir, mode, agent: agent || null, prompt: scrub(prompt), summary: trunc(prompt.replace(/\s+/g, ' ').trim(), 100),
      state: 'queued', created_at: nowIso(), started_at: null, finished_at: null, activity: 'queued',
      base_branch: base_branch || null, branch: null, original_branch: null, commits: null, pushed: null, pr_url: null,
      session_id: null, model: null, cost_usd: null, usage: null, num_turns: null, result_text: null, plan_file: null,
      error: null, notes: [], pid: null, limits, setup: { claude_md: setup.claude_md, preflight: setup.preflight, agents: setup.agents.map(a => a.name) },
    };
    fs.mkdirSync(this.jobDir(id), { recursive: true });
    this.jobs.set(id, job);
    this.save(job, { immediate: true });
    this.appendTranscript(job, `job ${id} queued: project=${name} mode=${mode}${agent ? ` agent=${agent}` : ''}`);
    setImmediate(() => this.pump());
    return { job_id: id, state: job.state, project: name, mode, queue_position: this.queuePosition(id), limits };
  }

  /** Start queued jobs while capacity allows. */
  pump() {
    const cap = this.cfg.limits.max_concurrent_jobs ?? 2;
    const queued = [...this.jobs.values()].filter(j => j.state === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const job of queued) {
      if (this.runningCount() >= cap) break;
      job.state = 'running';
      job.started_at = nowIso();
      job.activity = 'starting';
      this.save(job, { immediate: true });
      this.runJob(job).catch(e => {
        this.log.error(`job ${job.id} crashed: ${e.stack || e.message}`);
        this.finish(job, 'failed', `internal error: ${scrub(e.message)}`);
      });
    }
  }

  finish(job, state, error) {
    if (!ACTIVE.has(job.state)) return;
    job.state = state;
    job.finished_at = nowIso();
    if (error) job.error = scrub(error);
    job.activity = state;
    job.pid = null;
    this.procs.delete(job.id);
    this.save(job, { immediate: true });
    this.appendTranscript(job, `== job ${state}${error ? `: ${error}` : ''}`);
    setImmediate(() => this.pump());
  }

  // ---------- run ----------
  async runJob(job) {
    const dir = job.project_path;
    const ov = projectOverrides(this.cfg, job.project);
    const remote = await hasRemote(dir);

    // Branch setup for execute mode.
    if (job.mode === 'execute') {
      job.original_branch = currentBranchFast(dir);
      const base = job.base_branch || await defaultBranch(dir, ov.default_branch);
      job.base_branch = base;
      let startPoint = base;
      if (remote) {
        job.activity = `fetching origin/${base}`;
        this.save(job);
        const r = await run('git', ['fetch', '--quiet', 'origin', base], { cwd: dir, timeoutMs: 120_000 });
        if (r.code === 0) startPoint = `origin/${base}`;
        else { job.notes.push(`fetch of origin/${base} failed; branching from local ${base}`); this.appendTranscript(job, `fetch failed: ${r.stderr.trim()}`); }
      }
      if (!(await branchExists(dir, base)) && startPoint === base) {
        return this.finish(job, 'failed', `base branch ${base} does not exist in ${job.project}`);
      }
      const prefix = this.cfg.claude.branch_prefix || 'bridge/';
      job.branch = `${prefix}${slugify(job.summary)}-${job.id.slice(2, 10)}`;
      try {
        await git(['checkout', '--quiet', '-b', job.branch, startPoint], { cwd: dir, timeoutMs: 60_000 });
      } catch (e) {
        return this.finish(job, 'failed', `could not create branch ${job.branch}: ${e.message}`);
      }
      this.appendTranscript(job, `created branch ${job.branch} from ${startPoint} (was on ${job.original_branch || 'detached HEAD'})`);
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
    if (c.model) args.push('--model', c.model);
    args.push('--append-system-prompt', this.systemPrompt(job, { remote }));
    if (Array.isArray(c.extra_args)) args.push(...c.extra_args);
    return args;
  }

  systemPrompt(job, { remote }) {
    const lines = [
      `You are running unattended through the Claude Code Bridge (job ${job.id}) in the repository "${job.project}" at ${job.project_path}. Nobody can answer questions, so make sensible decisions yourself and state your assumptions in your final message.`,
      `Stay inside this repository. Never print secrets, tokens, or the contents of .env files in your output.`,
    ];
    if (job.mode === 'plan') {
      lines.push(
        `This is PLAN mode: investigate the codebase and produce a concrete, reviewable implementation plan as your final message — files to touch, the approach, risks, and how to verify. Do NOT modify any files and do NOT create branches or commits.`,
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
      const dir = job.project_path;
      const bin = this.cfg.claude.bin || 'claude';
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb',
        SHELL: process.env.SHELL || '/bin/bash',
        // Claude Code refuses bypassPermissions as root unless it believes it's sandboxed.
        IS_SANDBOX: '1',
        GIT_TERMINAL_PROMPT: '0',
        CLAUDE_CODE_BRIDGE_JOB: job.id,
      };
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
      if (ev.is_error) job._resultError = `claude reported an error (${ev.subtype || 'error'}): ${trunc(job.result_text || '', 500)}`;
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
    if (job.mode !== 'execute' || !job.branch) return;
    const dir = job.project_path;
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
        await this.restoreOriginal(job);
        await run('git', ['branch', '-D', job.branch], { cwd: dir });
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
      await this.restoreOriginal(job);
    } catch (e) {
      job.notes.push(`post-processing error: ${scrub(e.message)}`);
      this.appendTranscript(job, `post-processing error: ${e.message}`);
    } finally {
      this.save(job, { immediate: true });
    }
  }

  async restoreOriginal(job) {
    const dir = job.project_path;
    if (!job.original_branch || job.original_branch === job.branch) return;
    const r = await run('git', ['checkout', '--quiet', job.original_branch], { cwd: dir, timeoutMs: 60_000 });
    if (r.code === 0) this.appendTranscript(job, `restored working tree to ${job.original_branch}`);
    else { job.notes.push(`could not switch back to ${job.original_branch}: ${trunc(r.stderr.trim(), 200)}`); }
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
    const cleanup = [];
    if (job.mode === 'execute' && job.branch) {
      const dir = job.project_path;
      try {
        if (keep_branch) {
          const st = await workingTreeStatus(dir, { timeoutMs: 60_000 });
          if (st.dirty) {
            await git(['add', '-A'], { cwd: dir });
            await git(['-c', `user.name=${authorName(this.cfg)}`, '-c', `user.email=${authorEmail(this.cfg)}`, 'commit', '--quiet', '-m', `chore(bridge): partial work from cancelled job ${job.id}`], { cwd: dir });
            cleanup.push('committed partial work');
          }
          cleanup.push(`kept branch ${job.branch}`);
        } else {
          // Tree was clean when the job started, so discarding everything only drops agent output.
          await run('git', ['reset', '--hard', '--quiet'], { cwd: dir, timeoutMs: 60_000 });
          await run('git', ['clean', '-fdq'], { cwd: dir, timeoutMs: 60_000 });
          cleanup.push('discarded uncommitted changes');
        }
        await this.restoreOriginal(job);
        if (!keep_branch) {
          const r = await run('git', ['branch', '-D', job.branch], { cwd: dir });
          if (r.code === 0) { cleanup.push(`deleted branch ${job.branch}`); job.branch = null; }
          else cleanup.push(`could not delete branch ${job.branch}: ${trunc(r.stderr.trim(), 200)}`);
        }
      } catch (e) {
        cleanup.push(`cleanup error: ${scrub(e.message)}`);
      }
    }
    job.notes.push(...cleanup);
    this.finish(job, 'cancelled', 'cancelled by request');
    return { job_id: id, state: 'cancelled', cleanup };
  }

  /** Kill all running children (server shutdown). Jobs are marked interrupted on next init(). */
  shutdown() {
    for (const [id] of this.procs) { const job = this.jobs.get(id); if (job) { this.killTree(job); job.state = 'interrupted'; job.finished_at = nowIso(); job.error = 'server shut down while the job was running'; this.save(job, { immediate: true }); } }
  }
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
