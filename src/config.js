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
    // Model alias passed as --model; null = whatever the CLI defaults to.
    model: null,
    // Extra args appended verbatim (e.g. ["--effort","high"]).
    extra_args: [],
    // Branch prefix for execute-mode jobs.
    branch_prefix: 'bridge/',
    // Commit author used for any leftover-work commit the bridge makes itself.
    commit_author: 'Claude Code Bridge <claude-code-bridge@localhost>',
  },
  // Per-project overrides keyed by directory name. All keys optional.
  // Example: "my-app": { "default_branch": "develop", "job_timeout_minutes": 40,
  //                      "max_cost_usd": 10, "allow_untracked": true }
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
