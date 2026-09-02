// MCP tool surface. Every handler's output passes through the scrubber before it leaves.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { scrub, scrubDeep } from './scrub.js';
import { resolveProjectDir } from './paths.js';
import { git, run, workingTreeStatus, currentBranchFast, hasRemote } from './git.js';
import { cloneProject, listAvailableRepos } from './clone.js';
import { resolveComposeTarget, composeStatus, composeLogs, compose, validateServices, composeConfig, isProtected, protectedList } from './compose.js';

function ok(data, text) {
  const payload = scrubDeep(data);
  return {
    content: [{ type: 'text', text: scrub(text ?? JSON.stringify(payload, null, 2)) }],
    structuredContent: typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : { result: payload },
  };
}
function fail(err) {
  const msg = scrub(err?.message || String(err));
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true };
}
const wrap = fn => async args => { try { return await fn(args ?? {}); } catch (e) { return fail(e); } };

export function registerTools(server, { cfg, projects, jobs, goals, notify, log }) {
  // Log every tool call (name, outcome, duration) — never the arguments, which may carry prompts/paths.
  const origRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => origRegister(name, config, async (args, extra) => {
    const t0 = Date.now();
    const r = await handler(args, extra);
    const msg = `tool ${name} ${r?.isError ? 'error' : 'ok'} ${Date.now() - t0}ms${r?.isError ? `: ${String(r.content?.[0]?.text || '').slice(0, 200)}` : ''}`;
    if (r?.isError) log.warn(msg); else log.info(msg);
    return r;
  });
  server.registerTool('list_projects', {
    title: 'List projects',
    description: `Rescan the workspace root (${cfg.workspace_root}) and list every git repository in it: name, current branch, default branch, remote (credentials stripped), whether the working tree is dirty, whether a .claude setup exists (CLAUDE.md / .claude/preflight.md / .claude/agents) and which agents it exposes. Results are cached and refreshed on every call.`,
    inputSchema: {
      filter: z.string().optional().describe('Case-insensitive substring to match against project names'),
      verbose: z.boolean().optional().describe('Full detail per project (paths, agent descriptions, compose file metadata). Default is a compact listing.'),
    },
  }, wrap(async ({ filter, verbose }) => {
    const list = await projects.list({ refresh: true });
    let out = filter ? list.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())) : list;
    if (!verbose) {
      // Compact by default: this result lands in the chat context verbatim and is often called more than once.
      out = out.map(p => ({
        name: p.name, note: p.note || undefined, current_branch: p.current_branch, default_branch: p.default_branch, remote: p.remote, dirty: p.dirty,
        has_claude_setup: p.has_claude_setup, claude_md: p.claude_md || undefined, preflight: p.preflight || undefined,
        agents: p.agents.length ? p.agents.map(a => a.name) : undefined,
        compose: p.compose.length ? p.compose.map(c => c.file) : undefined,
        overrides: p.overrides,
      }));
    }
    return ok({ workspace_root: cfg.workspace_root, count: out.length, projects: out, note: verbose ? undefined : 'compact view; pass verbose=true for paths, agent descriptions and compose detail' });
  }));

  server.registerTool('clone_project', {
    title: 'Clone a repository into the workspace',
    description: `Clone a repo into ${cfg.workspace_root}/<name> using the machine's stored git credentials. Pass either url (https://, ssh:// or git@host:owner/repo) or repo ("owner/repo" on a configured host). Never overwrites: if <name> already exists its path is returned and nothing is touched. Shallow by default (depth ${cfg.clone.depth}); pass full_history=true for everything. Refuses names with separators, traversal or leading dots, and refuses non-https/ssh sources.`,
    inputSchema: {
      url: z.string().optional().describe('Clone URL (https://host/owner/repo, ssh://git@host/owner/repo, git@host:owner/repo.git)'),
      repo: z.string().optional().describe('Shorthand owner/repo; combined with host (defaults to the first configured host)'),
      host: z.string().optional().describe('Host for the owner/repo shorthand, e.g. github.com'),
      name: z.string().optional().describe('Local directory name (defaults to the repo name)'),
      branch: z.string().optional().describe('Branch to check out'),
      depth: z.number().int().min(0).optional().describe('Shallow clone depth; 0 = full history'),
      full_history: z.boolean().optional().describe('Clone full history (same as depth 0)'),
    },
  }, wrap(async args => {
    const r = await cloneProject(cfg, args);
    projects.invalidate();
    if (r.status === 'cloned') await projects.scan().catch(() => {});
    return ok(r, r.message || `${r.status}: ${r.name} at ${r.path}${r.branch ? ` (branch ${r.branch})` : ''}`);
  }, 'clone_project'));

  server.registerTool('list_available_repos', {
    title: 'List repos visible to the stored credentials',
    description: `List repositories the stored credentials can see on the configured hosts (${(cfg.clone.hosts || []).map(h => h.host).join(', ') || 'none configured'}), so a caller can pick one to clone. Marks repos already present locally.`,
    inputSchema: {
      host: z.string().optional().describe('Limit to one configured host'),
      query: z.string().optional().describe('Case-insensitive substring match on full name / description'),
      limit: z.number().int().min(1).max(500).optional().describe('Max repos to return (default 100)'),
    },
  }, wrap(async args => ok(await listAvailableRepos(cfg, args)), 'list_available_repos'));

  server.registerTool('start_task', {
    title: 'Start a Claude Code task',
    description: `Dispatch a natural-language task to Claude Code (headless) in a project. Returns a job_id immediately; poll get_task_status / get_task_log. mode "plan" (default) only investigates and returns a plan — no files change. mode "execute" creates a fresh branch off the default branch (never commits to it), lets Claude work, commits leftovers, pushes and opens a DRAFT PR when a remote exists (or reports the local branch when it doesn't). Nothing is ever merged. Every job runs in a disposable git worktree: the project checkout is never touched, a dirty checkout does not block anything (its uncommitted changes are simply invisible to the job), and multiple jobs may run on one project. Bounded by a hard timeout (${cfg.limits.job_timeout_minutes} min) and cost ceiling ($${cfg.limits.max_cost_usd}).`,
    inputSchema: {
      project: z.string().describe('Project name as shown by list_projects'),
      prompt: z.string().describe('What to do, in natural language'),
      mode: z.enum(['plan', 'execute']).optional().describe('plan (default, read-only) or execute'),
      agent: z.string().optional().describe('Name of a project agent from .claude/agents to run as'),
      base_branch: z.string().optional().describe('Branch to start from (defaults to the project default branch)'),
      max_cost_usd: z.number().positive().optional().describe('Override the cost ceiling for this job (default is per model tier)'),
      timeout_minutes: z.number().positive().max(180).optional().describe('Override the hard timeout for this job'),
      model: z.string().optional().describe(`Override model selection: a tier name (${Object.keys(cfg.models?.tiers || {}).join(', ')}), a configured model id/alias, or any model string. Omit to let the bridge choose (default tier unless an escalation trigger fires). Always honoured, up or down.`),
      complexity: z.enum(['low', 'normal', 'high']).optional().describe('"high" escalates to the complex tier (slower, more capable). "low" DE-escalates to the fast tier and low effort — use it for lookups, renames, status checks and other grep-shaped work, where it is markedly faster and cheaper.'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort for this job. Defaults come from the chosen tier. Effort drives adaptive reasoning and is usually the biggest lever on how long a job takes — lower it for scoped, well-specified tasks; raise it for genuinely hard ones.'),
      retry_of: z.string().optional().describe('job_id of a previous failed attempt; retries escalate automatically'),
      chat_id: z.string().optional().describe('Injected automatically by the chat client so the live feed can link back here. Do not invent one.'),
    },
  }, wrap(async args => {
    const r = await jobs.start(args);
    // The clash goes in the headline, not just the payload: a note buried in
    // JSON is a note the user never sees.
    const clash = r.concurrent_on_project
      ? ` ⚠ ${r.project} already has ${r.concurrent_on_project.count} other job(s) in flight — they cannot see each other's findings, and both are billed. Mention this to the user.`
      : '';
    return ok(r, `job ${r.job_id} ${r.state} (${r.mode} mode on ${r.project}, model ${r.model} — ${r.model_reason}${r.effort ? `; effort ${r.effort} — ${r.effort_reason}` : ''}).${clash} Poll get_task_status with this job_id.`);
  }, 'start_task'));

  server.registerTool('start_goal', {
    title: 'Start a goal',
    description: `Create a GOAL: one objective pursued by several jobs across several projects, sharing one budget and one findings record. Use this instead of repeated start_task when a single outcome spans more than one repository ("get passkeys working on every portal"). Children do not talk to each other — each reads every earlier child's findings when it starts, and its final message is appended for the ones that follow, so order matters: put the job others depend on first. The goal budget covers ALL children together and is checked before each dispatch, so the fan-out stops when the money runs out rather than after. Returns the goal_id and the dispatched jobs; poll goal_status.`,
    inputSchema: {
      objective: z.string().describe('The outcome, in one or two sentences. Every child sees this verbatim.'),
      jobs: z.array(z.object({
        project: z.string().describe('Project name as shown by list_projects'),
        prompt: z.string().describe("This child's slice of the objective"),
        mode: z.enum(['plan', 'execute']).optional(),
        model: z.string().optional(),
        complexity: z.enum(['low', 'normal', 'high']).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        agent: z.string().optional(),
        base_branch: z.string().optional(),
        max_cost_usd: z.number().positive().optional(),
        depends_on: z.array(z.number().int().min(0)).optional().describe('Indexes of earlier entries in this array that must finish first. Use it when a child needs an earlier one\'s findings — it waits, then starts with those findings already on the record. A failed predecessor still releases it.'),
      })).min(1).max(12).describe('One entry per project. Ordered — earlier children record findings the later ones read.'),
      budget_usd: z.number().positive().optional().describe(`Ceiling for the WHOLE goal, not per job (default $${cfg.goals?.budget_usd ?? 25}). Dispatch stops once it is spent.`),
      chat_id: z.string().optional().describe('Injected automatically by the chat client so the live feed can link back here. Do not invent one.'),
    },
  }, wrap(async ({ objective, jobs: children, budget_usd, chat_id }) => {
    const goal = goals.create({ objective, budget_usd, chat_id });
    // Announced before the children are dispatched, so the channel reads in the
    // order things actually happened rather than showing a goal appearing after
    // its own first job started.
    notify?.goalCreated(goal, children.length);
    const started = [], refused = [];
    // depends_on arrives as indexes into this array — the caller has no job ids
    // yet — and is resolved to ids as each child is created. A dependency on an
    // entry that was refused is dropped rather than stranding the dependent.
    const idByIndex = new Map();
    for (const [i, c] of children.entries()) {
      const { depends_on: deps, ...rest } = c;
      const resolved = (deps || [])
        .filter(d => d < i)
        .map(d => idByIndex.get(d))
        .filter(Boolean);
      try {
        const r = await jobs.start({ ...rest, goal_id: goal.id, depends_on: resolved, chat_id });
        idByIndex.set(i, r.job_id);
        started.push(r);
      } catch (e) { refused.push({ project: c.project, error: String(e.message || e) }); }
    }
    const clashes = started.filter(x => x.concurrent_on_project);
    return ok({ goal_id: goal.id, objective: goal.objective, budget_usd: goal.budget_usd, started, refused },
      `goal ${goal.id} created with ${started.length} job(s)${refused.length ? `, ${refused.length} refused` : ''} on a $${goal.budget_usd} budget.`
      + (clashes.length ? ` ⚠ ${clashes.length} of them landed on a project that already had work in flight — say so before continuing.` : '')
      + ' Poll goal_status with this goal_id.');
  }, 'start_goal'));

  server.registerTool('goal_status', {
    title: 'Get goal status',
    description: 'The whole board for one goal in a single call: per-job state, model, effort and cost; the totals; and the shared findings recorded so far. Prefer this over polling each job individually — it is one call instead of N, and it returns the findings record, which is where the actual answers accumulate.',
    inputSchema: { goal_id: z.string() },
  }, wrap(async ({ goal_id }) => {
    const st = goals.status(goal_id, jobs.jobs);
    const c = st.counts;
    return ok(st, `goal ${goal_id} ${st.state}: ${c.completed} done, ${c.running} running, ${c.queued} queued, ${c.failed} failed — $${st.spent_usd.toFixed(2)} of $${st.budget_usd.toFixed(2)}.`);
  }, 'goal_status'));

  server.registerTool('goal_cancel', {
    title: 'Cancel a goal',
    description: 'Stop a goal: cancels every running and queued child and blocks further dispatch. Work already committed to a child branch survives; nothing is reverted.',
    inputSchema: { goal_id: z.string() },
  }, wrap(async ({ goal_id }) => {
    const g = goals.cancel(goal_id);
    const stopped = [];
    for (const id of g.job_ids) {
      const j = jobs.jobs.get(id);
      if (j && (j.state === 'running' || j.state === 'queued')) {
        try { await jobs.cancel(id); stopped.push(id); } catch { /* already gone */ }
      }
    }
    return ok({ goal_id, state: g.state, cancelled_jobs: stopped }, `goal ${goal_id} cancelled; stopped ${stopped.length} job(s).`);
  }, 'goal_cancel'));

  server.registerTool('get_task_status', {
    title: 'Get task status',
    description: 'State (queued|running|completed|failed|cancelled|interrupted), elapsed time, current activity, branch, PR URL, model used + tier + why, cost, and the final result or plan text when finished. While a job is running this BLOCKS until the job actually ends, or until wait_seconds elapses (default 120, max 600) — it does NOT return early on every progress tick. Progress observed while waiting comes back as steps_while_waiting, so one call reports several steps. Call it once and wait; a tight poll loop is expensive because every call re-sends the whole conversation to the model. Running jobs return a lean payload; the full record comes when the job ends. For compose redeploy jobs: steps and service state before/after.',
    inputSchema: { job_id: z.string(), wait_seconds: z.number().min(0).max(600).optional().describe('Seconds to block waiting for the job to END (default 120, max 600; 0 = answer immediately without waiting)') },
  }, wrap(async ({ job_id, wait_seconds }) => {
    const w = wait_seconds === undefined ? 120 : wait_seconds;
    const trail = w > 0 ? await jobs.waitForChange(job_id, w * 1000) : [];
    return ok(jobs.status(job_id, { trail }));
  }));

  server.registerTool('get_task_log', {
    title: 'Get task log',
    description: 'Human-readable transcript for a job (secrets scrubbed). Use offset/next_offset for incremental polling. raw=true returns the underlying stream-json events instead.',
    inputSchema: {
      job_id: z.string(),
      offset: z.number().int().min(0).optional().describe('Byte offset to read from (use next_offset from the previous call)'),
      limit: z.number().int().min(1).max(200000).optional().describe('Max bytes to return (default 16384)'),
      raw: z.boolean().optional().describe('Return raw stream-json lines instead of the transcript'),
    },
  }, wrap(async args => {
    const r = jobs.readLog(args.job_id, args);
    return ok(r, r.text || (r.eof ? '(empty log)' : '(nothing new yet)'));
  }, 'get_task_log'));

  server.registerTool('cancel_task', {
    title: 'Cancel a task',
    description: 'Terminate a queued or running job. By default discards uncommitted agent changes, restores the original branch and deletes the job branch so nothing is orphaned; pass keep_branch=true to commit partial work and keep the branch instead.',
    inputSchema: { job_id: z.string(), keep_branch: z.boolean().optional() },
  }, wrap(async args => ok(await jobs.cancel(args.job_id, args)), 'cancel_task'));

  server.registerTool('update_checkout', {
    title: 'Update a project checkout (fast-forward only)',
    description: 'Bring a project\'s checked-out branch up to date with its remote: git fetch origin <branch> + merge --ff-only. This is the deploy primitive for stacks that build from their checkout (see each project\'s note in list_projects): merge the PR on the host, update_checkout, then compose_redeploy. Never rewrites history and never touches uncommitted files. Refuses when the checkout is dirty (someone\'s uncommitted work is in the live checkout — it lists the files so the human can decide), detached, without a remote, or when the update is not a fast-forward.',
    inputSchema: {
      project: z.string().describe('Project name as shown by list_projects'),
      branch: z.string().optional().describe('Safety check only: must equal the currently checked-out branch. Omit to update whatever branch is checked out.'),
    },
  }, wrap(async ({ project, branch }) => {
    const dir = resolveProjectDir(cfg, project);
    const name = path.relative(fs.realpathSync(cfg.workspace_root), dir);
    const current = currentBranchFast(dir);
    if (!current) throw new Error(`refused: ${name} is on a detached HEAD; check out a branch on the box first`);
    if (branch && branch !== current) throw new Error(`refused: ${name} has ${current} checked out, not ${branch}. update_checkout only fast-forwards the checked-out branch.`);
    if (!(await hasRemote(dir))) throw new Error(`refused: ${name} has no origin remote to update from`);
    const st = await workingTreeStatus(dir, { timeoutMs: 30_000 });
    if (st.dirty) {
      throw new Error(`refused: ${name} has ${st.entries.length} uncommitted change(s) in its live checkout — updating around them risks someone's in-progress work. A human should commit, stash or discard these first:\n` + st.entries.slice(0, 20).join('\n'));
    }
    return jobs.withComposeLock(name, 'update_checkout', async () => {
      const before = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
      await git(['fetch', '--quiet', 'origin', current], { cwd: dir, timeoutMs: 180_000 });
      const r = await run('git', ['merge', '--ff-only', '--quiet', `origin/${current}`], { cwd: dir, timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`not a fast-forward: local ${current} has diverged from origin/${current} (${r.stderr.trim().split('\n')[0] || 'merge refused'}). A human needs to reconcile on the box.`);
      const after = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
      const count = before === after ? 0 : Number((await git(['rev-list', '--count', `${before}..${after}`], { cwd: dir })).trim());
      const summary = count === 0 ? `${name} ${current} already up to date at ${after.slice(0, 8)}`
        : `${name} ${current} fast-forwarded ${before.slice(0, 8)} -> ${after.slice(0, 8)} (${count} commit${count === 1 ? '' : 's'}). If a Compose stack builds from this checkout, follow with compose_redeploy to ship it.`;
      return ok({ project: name, branch: current, before, after, commits: count, up_to_date: count === 0 }, summary);
    });
  }, 'update_checkout'));

  server.registerTool('list_jobs', {
    title: 'List recent jobs',
    description: 'Recent jobs (Claude Code tasks and compose redeploys) with state, project, model and a one-line summary. Filter by project or state.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional(),
      project: z.string().optional(),
      state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
    },
  }, wrap(async args => ok({ jobs: jobs.list(args) }), 'list_jobs'));

  // ---------------- Docker Compose ----------------
  const composeArgs = {
    project: z.string().describe('Project name as shown by list_projects'),
    file: z.string().optional().describe('Compose file (relative to the project) — required when the project has more than one'),
    services: z.array(z.string()).optional().describe('Limit to these services'),
    profile: z.string().optional().describe('Compose profile to enable'),
  };
  const protectedNote = `Protected stacks (refused): ${protectedList(cfg).join(', ')}.`;
  const statusText = list => list.length ? list.map(c => `${c.service}: ${c.state}${c.health ? ` (${c.health})` : ''} — ${c.status}${c.ports.length ? ` [${c.ports.join(', ')}]` : ''}`).join('\n') : '(no containers)';

  server.registerTool('compose_status', {
    title: 'Compose status',
    description: `docker compose ps for a project under ${cfg.workspace_root}: services, state, health, ports, uptime. Read-only.`,
    inputSchema: composeArgs,
  }, wrap(async ({ project, file, services, profile }) => {
    const target = resolveComposeTarget(cfg, project, { file, profile });
    const svc = validateServices(services);
    const list = await composeStatus(target, svc);
    return ok({ project: target.project, files: target.files, protected: !!target.protectedBy, services: list }, statusText(list));
  }, 'compose_status'));

  server.registerTool('compose_logs', {
    title: 'Compose logs',
    description: 'Tail container logs for a project (scrubbed for secrets). Args: services, lines (default 200, max 5000), since (e.g. 10m, 2h, ISO timestamp). Read-only.',
    inputSchema: { ...composeArgs, lines: z.number().int().min(1).max(5000).optional(), since: z.string().optional() },
  }, wrap(async ({ project, file, services, profile, lines, since }) => {
    const target = resolveComposeTarget(cfg, project, { file, profile });
    const text = await composeLogs(target, { services: validateServices(services), lines: lines ?? cfg.compose?.logs_default_lines ?? 200, since });
    return ok({ project: target.project, files: target.files, text }, text || '(no log output)');
  }, 'compose_logs'));

  const syncOp = (verb, subArgs, timeoutMs) => async ({ project, file, services, profile }) => {
    const target = resolveComposeTarget(cfg, project, { file, profile });
    if (target.protectedBy) throw new Error(`refused: ${target.protectedBy}. Use a terminal on the box for this stack.`);
    const svc = validateServices(services);
    return jobs.withComposeLock(target.project, `compose ${verb}`, async () => {
      const info = await composeConfig(target);
      const prot = isProtected(cfg, target.project, info.name);
      if (prot) throw new Error(`refused: ${prot}. Use a terminal on the box for this stack.`);
      const before = await composeStatus(target, svc);
      const r = await compose(target, [...subArgs, ...svc], { timeoutMs });
      const after = await composeStatus(target, svc);
      const output = (r.stdout + '\n' + r.stderr).trim();
      const result = { project: target.project, compose_project: info.name, files: target.files, ok: r.code === 0, exit_code: r.code, before, after, output: output.slice(-4000) };
      if (r.code !== 0) return { ...fail(new Error(`docker compose ${verb} failed (exit ${r.code}): ${output.split('\n').slice(-3).join(' | ')}`)), structuredContent: scrubDeep(result) };
      return ok(result, `compose ${verb} ok on ${target.project}\nbefore:\n${statusText(before)}\nafter:\n${statusText(after)}`);
    });
  };
  const restartTimeout = (cfg.compose?.restart_timeout_seconds ?? 180) * 1000;
  server.registerTool('compose_restart', { title: 'Compose restart', description: `Restart running services (docker compose restart). No rebuild, no pull. Returns service state before and after. ${protectedNote}`, inputSchema: composeArgs }, wrap(syncOp('restart', ['restart'], restartTimeout), 'compose_restart'));
  server.registerTool('compose_stop', { title: 'Compose stop', description: `Stop services (docker compose stop — containers are kept, nothing is removed). ${protectedNote}`, inputSchema: composeArgs }, wrap(syncOp('stop', ['stop'], restartTimeout), 'compose_stop'));
  server.registerTool('compose_up', { title: 'Compose up', description: `Start services (docker compose up -d --no-build; use compose_redeploy to pull/build). ${protectedNote}`, inputSchema: composeArgs }, wrap(syncOp('up', ['up', '-d', '--no-build'], restartTimeout), 'compose_up'));

  server.registerTool('compose_redeploy', {
    title: 'Compose redeploy (async)',
    description: `pull (for image services), build (for services with a build section; optional no_cache) then up -d. Returns a job_id immediately; follow with get_task_status (steps + service state before/after) and get_task_log. Hard timeout ${cfg.compose?.redeploy_timeout_minutes ?? 15} min — a timeout reports the step it died in and the resulting state. Never removes volumes, never prunes; --remove-orphans only if remove_orphans=true. ${protectedNote}`,
    inputSchema: { ...composeArgs, no_cache: z.boolean().optional(), remove_orphans: z.boolean().optional(), timeout_minutes: z.number().positive().max(120).optional() },
  }, wrap(async args => {
    const r = await jobs.startComposeRedeploy(args);
    return ok(r, `compose redeploy job ${r.job_id} queued for ${r.project} (${r.files.join(', ')}). Poll get_task_status.`);
  }, 'compose_redeploy'));

  // (tools registered)
}
