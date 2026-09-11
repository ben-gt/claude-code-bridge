// Configuration loading. config.json lives in the repo root (next to package.json);
// config.local.json (gitignored) is merged on top for machine-specific tweaks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export const DEFAULTS = {
  // Hard workspace boundary. Everything the bridge touches must resolve inside this.
  workspace_root: path.join(os.homedir(), 'code'),
  // Where job records, logs and the server token live (outside the repo).
  data_dir: path.join(os.homedir(), '.local', 'share', 'code-bridge'),
  server: {
    host: '0.0.0.0',
    port: 4010,
    // Path to a file containing the bearer token (0600). Created on first start if missing.
    token_file: path.join(os.homedir(), '.config', 'code-bridge', 'token'),
  },
  discovery: {
    depth: 1,
    exclusions: ['node_modules', 'code-bridge', 'claude-code-bridge'],
    // Directories starting with '.' are always skipped.
  },
  limits: {
    max_concurrent_jobs: 2,
    job_timeout_minutes: 20,
    max_cost_usd: 5,
    // Hard cap on how many job records list_jobs returns.
    list_jobs_max: 50,
  },
  learnings: {
    enabled: true,
    dir: path.join(REPO_ROOT, 'learnings'),
    max_age_days: 90,
    prompt_chars: 6000,
  },
  clone: {
    depth: 1,
    timeout_seconds: 600,
    max_size_mb: 2048,
    // Hosts the bridge knows how to talk to for list_available_repos and PR creation.
    // Credentials come from `git credential fill` (your git credential helper) — never from here.
    hosts: [
      { host: 'github.com', type: 'github' },
    ],
  },
  claude: {
    // Command used to invoke Claude Code. Resolved via PATH unless absolute.
    bin: 'claude',
    // Extra args appended verbatim (e.g. ["--effort","high"]).
    extra_args: [],
    // Branch prefix for execute-mode jobs.
    branch_prefix: 'bridge/',
    // Commit author used for any leftover-work commit the bridge makes itself.
    commit_author: 'Code Bridge <code-bridge@localhost>',
    // Model for subagents a job spawns. Subagents otherwise INHERIT the parent
    // model, so a codebase sweep under an Opus job runs at Opus latency and
    // Opus prices to do grep-shaped work. CLAUDE_CODE_SUBAGENT_MODEL overrides
    // both the Agent tool's model parameter and any agent frontmatter.
    // null/'' leaves Claude Code's own behaviour alone.
    subagent_model: 'claude-haiku-4-5',
    // Background/non-essential model calls buy an unattended job nothing —
    // no human is reading them. Sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
    disable_nonessential_traffic: true,
  },
  // Which CLI runs a job when the caller does not say: 'claude' or 'codex'.
  default_engine: 'codex',
  // OpenAI Codex CLI as a second engine (start_task engine: "codex"). Same
  // worktrees, branches, draft PRs, goals and transcripts as a Claude job; only
  // the process underneath differs. See src/codex.js for what was verified.
  codex: {
    bin: 'codex',
    // Appended verbatim before the prompt. Do not put --model or effort here.
    extra_args: [],
    // Empty: the host's `codex login` (~/.codex/auth.json) is used. A key here
    // is passed as CODEX_API_KEY — `codex exec` ignores OPENAI_API_KEY. It is
    // a secret: config.local.json, never config.json.
    api_key: '',
    // Plan jobs always run in Codex's read-only sandbox. Execute jobs:
    //  'danger-full-access' — no sandbox, like the Claude path's
    //     bypassPermissions: the agent can install deps, run tests and commit.
    //  'workspace-write' — writes confined to the worktree, no network, and .git
    //     is read-only so the agent cannot commit; the bridge commits for it.
    execute_sandbox: 'danger-full-access',
    // Codex reads AGENTS.md; this lets it read CLAUDE.md too, so repos set up
    // for Claude only still give Codex their instructions.
    read_claude_md: true,
    // Same tier names as models.tiers, so escalation works identically. Ids
    // from `codex debug models` on codex-cli 0.154.0 (2026-09-11). The ceilings
    // only mean anything with a pricing entry — see below.
    tiers: {
      fast: { model: 'gpt-5.6-luna', max_cost_usd: 2, aliases: ['luna'], effort: 'low' },
      default: { model: 'gpt-5.6-terra', max_cost_usd: 5, aliases: ['codex', 'terra'], effort: 'medium' },
      complex: { model: 'gpt-6-astra', max_cost_usd: 12, aliases: ['astra'], effort: 'high' },
    },
    // USD per million tokens keyed by model id:
    //   { "gpt-5.6-terra": { "input": 0, "cached_input": 0, "output": 0 } }
    // Codex reports tokens, never cost. With no entry a Codex job's cost is
    // unknown, its ceiling cannot be checked, and it counts as $0 against a goal
    // budget. Deliberately empty rather than guessed.
    pricing: {},
  },
  // Model tiers. Names are policy; ids were confirmed against Claude Code 2.1.251
  // and the live Models API on 2026-09-02. Change here, not in code.
  //
  // claude-fable-5-1 (Claude Fable 5.1, released 2026-08-28) supersedes
  // claude-fable-5 on the complex tier: 1M context, 128K max output, and all
  // five effort levels (low/medium/high/xhigh/max) per its Models API
  // capabilities. It is the most expensive model here by a wide margin, which
  // is exactly why the tier carries an explicit effort and its own cost
  // ceiling rather than inheriting either. claude-fable-5 is still reachable
  // by passing the raw id as `model`.
  models: {
    default_tier: 'default',
    complex_tier: 'complex',
    // Tier used when the caller passes complexity "low" — lookups, renames,
    // status checks, grep-shaped questions.
    fast_tier: 'fast',
    // Effort for a tier that does not name one. Claude Code's own default is
    // 'high' on current models, and on routine work the thinking tokens
    // dominate wall-clock time, so 'high' everywhere is the slow default.
    default_effort: 'medium',
    tiers: {
      fast: { model: 'claude-haiku-4-5', max_cost_usd: 2, aliases: ['haiku', 'fast'], effort: 'low' },
      default: { model: 'claude-opus-5', max_cost_usd: 5, aliases: ['opus'], effort: 'medium' },
      complex: { model: 'claude-fable-5-1', max_cost_usd: 12, aliases: ['fable', 'fable-5-1'], effort: 'high' },
    },
    // Crude, explainable escalation triggers — expected to be tuned.
    escalation: {
      complex_agents: [],          // agent names that always run on the complex tier
      prompt_length_chars: 2500,   // longer prompts escalate
      file_references: 6,          // prompts naming more files than this escalate
      plan_without_claude_setup: true,
      retry_after_failure: true,
    },
  },
  // Goals: one objective, many jobs, one budget, one shared findings record.
  // The budget is deliberately goal-wide — eight children under a per-job
  // ceiling is eight times that ceiling, which is not a limit anyone chose.
  goals: {
    budget_usd: 25,
    // How long a supervised goal waits for a yes before discarding its held
    // work. Silence is never approval.
    approval_timeout_minutes: 60,
  },
  // Live job state pushed to an Open WebUI channel. Open WebUI emits a channel
  // message over its socket the moment it lands, so this is real push with no
  // polling and no patch to Open WebUI. webhook_url carries a token, so it
  // belongs in config.local.json (gitignored), never config.json.
  notify: {
    enabled: true,
    webhook_url: '',
    timeout_ms: 5000,
    // Base URL of the chat UI, so a channel line can link back to the
    // conversation that asked for the work.
    chat_base_url: '',
  },
  // Quota failover. When a job dies because the ACCOUNT ran out of room (a
  // subscription session cap, a rate limit), re-queue it once with an Anthropic
  // API key in its environment so the work finishes instead of waiting for the
  // cap to reset. Off by default and never in config.json: the subscription is
  // flat-rate while a key is billed per token, so this trades a stall for a
  // bill and must be a deliberate choice. Put api_key in config.local.json.
  failover: {
    enabled: false,
    api_key: '',
  },
  compose: {
    // Compose projects (directory name OR compose project name) the bridge refuses to touch.
    // The stack that serves the chat UI and the other MCP servers on this box are protected by default.
    protected: ['openui', 'form-submissions', 'dms-v3-form-submissions', 'code-bridge', 'claude-code-bridge'],
    redeploy_timeout_minutes: 15,
    restart_timeout_seconds: 180,
    logs_default_lines: 200,
  },
  // Per-project overrides keyed by directory name. All keys optional.
  // Example: "my-app": { "default_branch": "develop", "job_timeout_minutes": 40,
  //                      "max_cost_usd": 10, "allow_untracked": true, "tier": "complex" }
  projects: {},
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra) || typeof base !== 'object' || base === null || typeof extra !== 'object' || extra === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
  return out;
}

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Failed to parse ${p}: ${e.message}`);
  }
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function loadConfig(overridePath = process.env.BRIDGE_CONFIG) {
  const main = overridePath ? readJsonIfExists(overridePath) : readJsonIfExists(path.join(REPO_ROOT, 'config.json'));
  const local = readJsonIfExists(path.join(REPO_ROOT, 'config.local.json'));
  const cfg = deepMerge(deepMerge(DEFAULTS, main), local);
  cfg.workspace_root = path.resolve(expandHome(cfg.workspace_root));
  cfg.data_dir = path.resolve(expandHome(cfg.data_dir));
  cfg.server.token_file = path.resolve(expandHome(cfg.server.token_file));
  cfg.learnings.dir = path.resolve(expandHome(cfg.learnings.dir));
  // Existing installations keep their history and bearer token. Only the new
  // conventional defaults can fall back; explicit custom paths stay untouched.
  cfg.data_dir = existingBridgePath(cfg.data_dir, '.local/share/code-bridge', '.local/share/claude-code-bridge');
  cfg.server.token_file = existingBridgePath(cfg.server.token_file, '.config/code-bridge/token', '.config/claude-code-bridge/token');
  if (process.env.BRIDGE_PORT) cfg.server.port = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_HOST) cfg.server.host = process.env.BRIDGE_HOST;
  return cfg;
}

export function existingBridgePath(configured, current, legacy, home = os.homedir()) {
  if (configured !== path.join(home, current) || fs.existsSync(configured)) return configured;
  const old = path.join(home, legacy);
  return fs.existsSync(old) ? old : configured;
}

export function projectOverrides(cfg, name) {
  return cfg.projects?.[name] ?? {};
}
