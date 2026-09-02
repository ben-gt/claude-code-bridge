// Claude Code Bridge — MCP server (Streamable HTTP) exposing Claude Code headless for ~/code.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, REPO_ROOT } from './config.js';
import { ProjectIndex } from './projects.js';
import { JobManager } from './jobs.js';
import { GoalManager } from './goals.js';
import { registerTools } from './tools.js';
import { addSecret, scrub } from './scrub.js';
import { cleanCloneTemp } from './clone.js';
import { detectSelfComposeProject, dockerAvailable, protectedList } from './compose.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a.map(scrub)),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a.map(scrub)),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a.map(scrub)),
};

function loadOrCreateToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
    log.warn(`token in ${file} is too short; regenerating`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const t = `ccb_${randomBytes(32).toString('base64url')}`;
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  log.info(`generated new bearer token at ${file}`);
  return t;
}

function constantTimeEq(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function main() {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.workspace_root)) throw new Error(`workspace_root ${cfg.workspace_root} does not exist`);
  fs.mkdirSync(cfg.data_dir, { recursive: true });
  const token = loadOrCreateToken(cfg.server.token_file);
  addSecret(token);

  const projects = new ProjectIndex(cfg);
  const goals = new GoalManager(cfg, { log });
  goals.init();
  const jobs = new JobManager(cfg, projects, { log, goals });
  jobs.init();
  cleanCloneTemp(cfg);
  const self = await detectSelfComposeProject();
  const composeVer = await dockerAvailable();
  log.info(`docker compose: ${composeVer ? `v${composeVer}` : 'NOT AVAILABLE (compose tools will fail)'}; protected stacks: ${protectedList(cfg).join(', ')}${self ? ` (self: ${self})` : ''}`);
  log.info(`model tiers: ${Object.entries(cfg.models?.tiers || {}).map(([k, v]) => `${k}=${v.model} ($${v.max_cost_usd})`).join(', ')}`);
  projects.scan().then(p => log.info(`discovered ${p.length} project(s) under ${cfg.workspace_root}`)).catch(e => log.error(`initial scan failed: ${e.message}`));

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, running_jobs: jobs.runningCount(), workspace_root: cfg.workspace_root });
  });

  // Bearer auth — same scheme as the other MCP servers registered in Open WebUI.
  app.use('/mcp', (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m || !constantTimeEq(m[1].trim(), token)) {
      res.set('WWW-Authenticate', 'Bearer realm="claude-code-bridge"');
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    }
    next();
  });

  // Stateless transport: one McpServer+transport per request, no session bookkeeping to lose on restart.
  const handle = async (req, res) => {
    const server = new McpServer({ name: 'claude-code-bridge', version: VERSION }, { instructions: [
      `Claude Code Bridge: dispatches engineering tasks to Claude Code (headless) against repositories under ${cfg.workspace_root}, and clones new ones.`,
      'Workflow: list_projects -> start_task (mode "plan" by default; pass mode "execute" to make changes) -> poll get_task_status / get_task_log (use next_offset) -> report the branch / draft PR URL. Nothing is ever merged automatically.',
      'Jobs run in disposable git worktrees: a dirty checkout never blocks a job and jobs never touch the checkout. Deploying a stack that builds from its checkout: merge the PR, update_checkout, compose_redeploy (projects carry a note in list_projects when this applies).',
      'Tasks run for minutes: start_task returns immediately with a job_id; poll rather than wait.',
    ].join('\n') });
    registerTools(server, { cfg, projects, jobs, goals, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error(`mcp request failed: ${e.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  };
  app.post('/mcp', handle);
  app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless server: use POST' }, id: null }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless server' }, id: null }));

  const httpServer = app.listen(cfg.server.port, cfg.server.host, () => {
    log.info(`claude-code-bridge v${VERSION} listening on http://${cfg.server.host}:${cfg.server.port}/mcp (workspace ${cfg.workspace_root}, data ${cfg.data_dir})`);
  });

  const shutdown = sig => {
    log.info(`${sig} received; shutting down`);
    jobs.shutdown();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', e => log.error(`uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', e => log.error(`unhandled rejection: ${e?.stack || e}`));
}

main().catch(e => { log.error(`fatal: ${e.stack || e.message}`); process.exit(1); });
