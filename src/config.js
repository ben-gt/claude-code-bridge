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
  data_dir: path.join(os.homedir(), '.local', 'share', 'claude-code-bridge'),
  server: {
    host: '0.0.0.0',
    port: 4010,
    // Path to a file containing the bearer token (0600). Created on first start if missing.
    token_file: path.join(os.homedir(), '.config', 'claude-code-bridge', 'token'),
  },
  discovery: {
    depth: 1,
    exclusions: ['node_modules'],
    // Directories starting with '.' are always skipped.
  },
  limits: {
    max_concurrent_jobs: 2,
    job_timeout_minutes: 20,
    max_cost_usd: 5,
    // Hard cap on how many job records list_jobs returns.
    list_jobs_max: 50,
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
    commit_author: 'Claude Code Bridge <claude-code-bridge@localhost>',
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
  },
  compose: {
    // Compose projects (directory name OR compose project name) the bridge refuses to touch.
    // The stack that serves the chat UI and the other MCP servers on this box are protected by default.
    protected: ['openui', 'form-submissions', 'dms-v3-form-submissions', 'claude-code-bridge'],
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
  if (process.env.BRIDGE_PORT) cfg.server.port = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_HOST) cfg.server.host = process.env.BRIDGE_HOST;
  return cfg;
}

export function projectOverrides(cfg, name) {
  return cfg.projects?.[name] ?? {};
}
