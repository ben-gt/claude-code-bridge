// MCP tool surface. Every handler's output passes through the scrubber before it leaves.
import { z } from 'zod';
import { scrub, scrubDeep } from './scrub.js';
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

export function registerTools(server, { cfg, projects, jobs, log }) {
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
        name: p.name, current_branch: p.current_branch, default_branch: p.default_branch, remote: p.remote, dirty: p.dirty,
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
    description: `Dispatch a natural-language task to Claude Code (headless) in a project. Returns a job_id immediately; poll get_task_status / get_task_log. mode "plan" (default) only investigates and returns a plan — no files change. mode "execute" creates a fresh branch off the default branch (never commits to it), lets Claude work, commits leftovers, pushes and opens a DRAFT PR when a remote exists (or reports the local branch when it doesn't). Nothing is ever merged. Refused if the working tree is dirty or the project already has an active job. Bounded by a hard timeout (${cfg.limits.job_timeout_minutes} min) and cost ceiling ($${cfg.limits.max_cost_usd}).`,
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
      retry_of: z.string().optional().describe('job_id of a previous failed attempt; retries escalate automatically'),
    },
  }, wrap(async args => {
    const r = await jobs.start(args);
    return ok(r, `job ${r.job_id} ${r.state} (${r.mode} mode on ${r.project}, model ${r.model} — ${r.model_reason}). Poll get_task_status with this job_id.`);
  }, 'start_task'));

  server.registerTool('get_task_status', {
    title: 'Get task status',
    description: 'State (queued|running|completed|failed|cancelled|interrupted), elapsed time, current activity, branch, PR URL, model used + tier + why, cost, and the final result or plan text when finished. While a job is running this LONG-POLLS: it waits up to wait_seconds (default 20, max 50) for the state/activity to change before answering, so call it once per check rather than repeatedly. Running jobs return a lean payload; the full record comes when the job ends. For compose redeploy jobs: steps and service state before/after.',
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
    description: 'Terminate a queued or running job. By default discards uncommitted agent changes, restores the original branch and deletes the job branch so nothing is orphaned; pass keep_branch=true to commit partial work and keep the branch instead.',
    inputSchema: { job_id: z.string(), keep_branch: z.boolean().optional() },
  }, wrap(async args => ok(await jobs.cancel(args.job_id, args)), 'cancel_task'));

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
