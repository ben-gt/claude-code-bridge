// MCP tool surface. Every handler's output passes through the scrubber before it leaves.
import { z } from 'zod';
import { scrub, scrubDeep } from './scrub.js';
import { cloneProject, listAvailableRepos } from './clone.js';
import { resolveComposeTarget, composeStatus, composeLogs, compose, validateServices, composeConfig, isProtected, protectedList } from './compose.js';
import { experimentOptions } from './experiments.js';

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

export function registerTools(server, { cfg, projects, jobs, log }) {
  // Log every tool call (name, outcome, duration) — never the arguments, which may carry prompts/paths.
  const origRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => origRegister(name, config, async (args, extra) => {
    if (cfg.execution_branch && ['compose_redeploy','compose_restart','compose_stop','compose_up'].includes(name)) return fail(new Error('Demo deployment requires the shared build lock and current release configuration; use the demo deployment workflow.'));
    const t0 = Date.now();
    const r = await handler(args, extra);
    const msg = `tool ${name} ${r?.isError ? 'error' : 'ok'} ${Date.now() - t0}ms${r?.isError ? `: ${String(r.content?.[0]?.text || '').slice(0, 200)}` : ''}`;
    if (r?.isError) log.warn(msg); else log.info(msg);
    return r;
  });
  server.registerTool('list_projects', {
    title: 'List projects',
    description: `Rescan the workspace root (${cfg.workspace_root}) and list every git repository in it: name, current branch, default branch, remote (credentials stripped), dirty flag, ahead/behind counts and diverged flag against the last fetched origin ref (null if unknown; this listing does not fetch), whether a .claude setup exists (CLAUDE.md / .claude/preflight.md / .claude/agents) and which agents it exposes. Results are cached and refreshed on every call.`,
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
        name: p.name, current_branch: p.current_branch, default_branch: p.default_branch, remote: p.remote, dirty: p.dirty,
        tracking_ref: p.tracking_ref, ahead: p.ahead, behind: p.behind, diverged: p.diverged,
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
    if (cfg.execution_branch) { if (args.branch && args.branch !== cfg.execution_branch) throw new Error('Only the demo branch may be cloned'); args.branch = cfg.execution_branch; }
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
    description: `Dispatch a natural-language task to Claude Code (headless) in a project. Returns a job_id immediately; poll get_task_status / get_task_log. mode "plan" (default) only investigates and returns a plan — no files change. mode "execute" creates a fresh branch off the default branch (never commits to it), lets Claude work, commits leftovers, pushes and opens a DRAFT PR when a remote exists (or reports the local branch when it doesn't). Nothing is ever merged. One job runs per project at a time: a job asked for while the project is busy is QUEUED (queue_position, waiting_for) and starts by itself when the checkout is free — do not re-submit it. Refused only if the working tree holds uncommitted changes that belong to nobody's job. Where a project has a deploy command configured, an execute job that pushed commits then builds and deploys them to the demo before it reports (its result ends with a "Deployment" section saying whether the change is live); pass deploy=false to skip that. Bounded by a hard timeout (${cfg.limits.job_timeout_minutes} min) and cost ceiling ($${cfg.limits.max_cost_usd}).`,
    inputSchema: {
      project: z.string().describe('Project name as shown by list_projects'),
      prompt: z.string().describe('What to do, in natural language'),
      mode: z.enum(['plan', 'execute']).optional().describe('plan (default, read-only) or execute'),
      agent: z.string().optional().describe('Name of a project agent from .claude/agents to run as'),
      base_branch: z.string().optional().describe('Branch to start from (defaults to the project default branch)'),
      max_cost_usd: z.number().positive().optional().describe('Override the cost ceiling for this job (default is per model tier)'),
      timeout_minutes: z.number().positive().max(180).optional().describe('Override the hard timeout for this job'),
      model: z.string().optional().describe(`Override model selection: a tier name (${Object.keys(cfg.models?.tiers || {}).join(', ')}), a configured model id/alias, or any model string. Omit to let the bridge choose (default tier unless an escalation trigger fires). Always honoured, up or down.`),
      complexity: z.enum(['low', 'normal', 'high']).optional().describe('"high" escalates to the complex tier'),
      ticket_context: z.object({ticket_id:z.string(),text:z.string().max(200000),attachments:z.array(z.object({filename:z.string(),data_base64:z.string()})).max(20)}).optional().describe('Authorised ticket text and attachment bytes supplied by the Robut gateway; kept outside the repository.'),
      retry_of: z.string().optional().describe('job_id of a previous failed attempt; retries escalate automatically'),
      deploy: z.boolean().optional().describe('execute mode only: deploy the pushed commits to the demo when the job finishes (default: the project\'s configured setting). false = push only.'),
    },
  }, wrap(async args => {
    const r = await jobs.start(args);
    return ok(r, `job ${r.job_id} ${r.state} (${r.mode} mode on ${r.project}, model ${r.model} — ${r.model_reason}${r.deploys_when_done ? '; deploys to the demo when done' : ''}).${r.waiting_for ? ` Queued behind ${r.waiting_for}; it starts by itself.` : ''} Poll get_task_status with this job_id.`);
  }, 'start_task'));

  server.registerTool('continue_task', {
    title: 'Continue a stopped task',
    description: 'Resume the Claude session of a job that stopped short — cost ceiling, timeout or a restart — in the same checkout, keeping its context, commits and unfinished edits (parked by the bridge when it stopped, put back when it resumes), under a fresh cost ceiling and time limit. Use this instead of start_task whenever get_task_status shows next_step: starting again pays to rediscover the repository and can collide with the work already there. Returns a new job_id; poll it like any other. Optional prompt replaces the default "continue and finish" instruction.',
    inputSchema: {
      job_id: z.string().describe('The stopped job to continue'),
      prompt: z.string().max(12000).optional().describe('What to do next (default: finish the original task and summarise)'),
      max_cost_usd: z.number().positive().optional().describe('Cost ceiling for this continuation (default is the tier ceiling)'),
      timeout_minutes: z.number().positive().max(180).optional().describe('Hard timeout for this continuation'),
    },
  }, wrap(async args => {
    const r = await jobs.continueJob(args);
    // Same opening as start_task ("job <id> <state> ("): Robut's watcher recognises a new job by it.
    return ok(r, `job ${r.job_id} ${r.state} (continues ${r.continues}; ${r.mode} mode on ${r.project}, model ${r.model}).${r.waiting_for ? ` Queued behind ${r.waiting_for}; it starts by itself.` : ''} Poll get_task_status with this job_id.`);
  }, 'continue_task'));

  const xo = experimentOptions(cfg);
  server.registerTool('start_experiment', {
    title: 'Start a measured experiment',
    description: `Run an optimisation loop on a project (after karpathy/autoresearch): Claude proposes ONE change per attempt; the bridge commits it, runs measure_command, keeps the commit only if the metric improved (and check_command, if given, still passes) and reverts it otherwise, then feeds the outcome back and asks for the next change. Use it when there is a single number that says "better" and a command that prints it — a benchmark time, a bundle size, a score from an evaluation script, a count of failing cases. It is the wrong tool for a bug fix or a feature (use start_task). The agent may change only the paths in editable; the measurement, its inputs and the tests must lie outside them. Returns a job_id immediately; follow it with get_task_status like any job. Kept commits collect on a local experiment branch and nothing is pushed: apply_experiment publishes them. Stops after max_iterations attempts, patience attempts in a row without improvement, the target, the cost ceiling or the time limit (default ${xo.timeout_minutes} min), whichever comes first. Refused if the working tree is dirty or the project has an active job.`,
    inputSchema: {
      project: z.string().describe('Project name as shown by list_projects'),
      objective: z.string().max(4000).describe('What should improve and anything the agent should know: where the cost is suspected, what must not change'),
      measure_command: z.string().max(2000).describe('Shell command the bridge runs from the repository root after every attempt. It must exit 0 and print the metric as a line "metric: <number>" (or "<metric_name>: <number>"), or a bare number on its last line. Keep it fast and deterministic: it runs once per attempt'),
      direction: z.enum(['minimize', 'maximize']).describe('Whether a lower or a higher metric is better'),
      editable: z.array(z.string()).min(1).max(20).describe('Repository-relative files or directories the agent may change. Anything else it touches discards the attempt. Never include the measurement script, its fixtures or the tests'),
      metric_name: z.string().optional().describe('Label of the metric line the command prints (default "metric")'),
      check_command: z.string().max(2000).optional().describe('Guard that must exit 0 for a change to be kept, e.g. the unit tests of the code being optimised, so a faster-but-broken change is discarded'),
      setup_command: z.string().max(2000).optional().describe('Run once before the baseline, e.g. "npm ci". May only produce files git ignores'),
      max_iterations: z.number().int().min(1).max(xo.max_iterations).optional().describe(`Attempts to make at most (default ${xo.default_iterations})`),
      patience: z.number().int().min(1).optional().describe(`Stop after this many attempts in a row without improvement (default ${xo.default_patience})`),
      min_improvement: z.number().min(0).optional().describe('How much better than the best so far a result must be to count (default 0). Set it above the run-to-run noise of the measurement'),
      measure_runs: z.number().int().min(1).max(5).optional().describe('Run the measurement this many times and take the median (default 1). Use 3 for timings'),
      measure_timeout_seconds: z.number().int().min(5).max(xo.max_measure_timeout_seconds).optional().describe(`Limit for one run of measure_command or check_command (default ${xo.measure_timeout_seconds})`),
      target: z.number().optional().describe('Stop as soon as the metric reaches this value'),
      max_cost_usd: z.number().positive().optional().describe('Cost ceiling for the whole experiment (default is the model tier ceiling)'),
      timeout_minutes: z.number().positive().max(xo.max_timeout_minutes).optional().describe(`Time limit for the whole experiment (default ${xo.timeout_minutes})`),
      model: z.string().optional().describe('Model tier or id; omit to let the bridge choose'),
      base_branch: z.string().optional().describe('Branch to start from (defaults to the project default branch)'),
    },
  }, wrap(async args => {
    const r = await jobs.startExperiment(args);
    // Same opening as start_task ("job <id> <state> ("): chat-side watchers recognise a new job by it.
    return ok(r, `job ${r.job_id} ${r.state} (experiment on ${r.project}: ${r.experiment.metric_name}, ${r.experiment.direction}, up to ${r.experiment.max_iterations} attempts, ceiling $${r.limits.max_cost_usd}, ${r.limits.timeout_minutes} min). Poll get_task_status with this job_id.`);
  }, 'start_experiment'));

  server.registerTool('apply_experiment', {
    title: 'Apply an experiment',
    description: `Publish the kept commits of a finished experiment${cfg.execution_branch ? `: put them on ${cfg.execution_branch} (fast-forward when it has not moved, otherwise cherry-pick) and push` : ': push the experiment branch and open a draft PR'}. Refused while the experiment runs, when it kept nothing, when it was already applied, or when its commits no longer apply cleanly (nothing is changed in that case). When the branch had moved, the result says the metric was not re-measured on the new base.`,
    inputSchema: { job_id: z.string().describe('The experiment job') },
  }, wrap(async args => {
    const r = await jobs.applyExperiment(args);
    return ok(r, r.summary);
  }, 'apply_experiment'));

  server.registerTool('get_task_status', {
    title: 'Get task status',
    description: 'State (queued|running|completed|failed|cancelled|interrupted), elapsed time, current activity, branch, PR URL, model used + tier + why, cost, and the final result or plan text when finished. A job that stopped short (error_code cost_ceiling or job_timeout) still returns the last message from the agent as result, says where its commits are, and carries next_step naming the continue_task call that finishes it. While a job is running this LONG-POLLS: it waits up to wait_seconds (default 20, max 50) for the state/activity to change before answering, so call it once per check rather than repeatedly. Running jobs return a lean payload; the full record comes when the job ends. For compose redeploy jobs: steps and service state before/after. For experiments: baseline, best and attempts so far while running; when finished, every attempt with its metric, and the report as result.',
    inputSchema: { job_id: z.string(), wait_seconds: z.number().min(0).max(50).optional().describe('Seconds to wait for a change while the job is active (default 20; 0 = answer immediately)') },
  }, wrap(async ({ job_id, wait_seconds }) => {
    const w = wait_seconds === undefined ? 20 : wait_seconds;
    if (w > 0) await jobs.waitForChange(job_id, w * 1000);
    return ok(jobs.status(job_id));
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
    description: 'Terminate a queued or running job. By default discards uncommitted agent changes, restores the original branch and deletes the job branch so nothing is orphaned; pass keep_branch=true to commit partial work and keep the branch instead. Cancelling an experiment drops only the attempt in progress: commits it had already kept stay on its branch and can still be applied.',
    inputSchema: { job_id: z.string(), keep_branch: z.boolean().optional() },
  }, wrap(async args => ok(await jobs.cancel(args.job_id, args)), 'cancel_task'));

  server.registerTool('list_jobs', {
    title: 'List recent jobs',
    description: 'Recent jobs (Claude Code tasks, experiments and compose redeploys) with state, project, model and a one-line summary. Filter by project or state.',
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
