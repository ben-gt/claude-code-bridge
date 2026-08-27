// Project discovery: scan the workspace root for git repos and describe each one.
import fs from 'node:fs';
import path from 'node:path';
import { realWorkspaceRoot, isInside } from './paths.js';
import { isGitRepo, currentBranchFast, remoteUrlFast, defaultBranch, workingTreeStatus } from './git.js';
import { projectOverrides } from './config.js';
import { findComposeFiles } from './compose.js';

/** Parse YAML-ish frontmatter from an agent .md — we only need name/description. */
export function parseAgentFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fallback = path.basename(file, '.md');
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return { name: fallback, description: '' };
  const get = key => {
    const m = fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    if (!m) return '';
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.replace(/\\n/g, ' ').replace(/\s+/g, ' ');
  };
  const description = get('description');
  return {
    name: get('name') || fallback,
    description: description.length > 240 ? description.slice(0, 237) + '...' : description,
    model: get('model') || undefined,
  };
}

export function detectClaudeSetup(dir) {
  const entries = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  const claudeMd = entries.find(e => e.toLowerCase() === 'claude.md') || null;
  const dotClaude = path.join(dir, '.claude');
  const preflight = fs.existsSync(path.join(dotClaude, 'preflight.md')) ? '.claude/preflight.md' : null;
  const agentsDir = path.join(dotClaude, 'agents');
  let agents = [];
  if (fs.existsSync(agentsDir)) {
    agents = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => parseAgentFile(path.join(agentsDir, f)))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const hasSettings = fs.existsSync(path.join(dotClaude, 'settings.json')) || fs.existsSync(path.join(dotClaude, 'settings.local.json'));
  const has = !!(claudeMd || preflight || agents.length || hasSettings);
  return { has_claude_setup: has, claude_md: claudeMd, preflight, agents, has_settings: hasSettings };
}

function listCandidateDirs(root, depth, exclusions) {
  const out = [];
  const walk = (dir, level) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (ent.name.startsWith('.')) continue;
      if (exclusions.includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      let real;
      try { real = fs.realpathSync(full); } catch { continue; }
      if (!isInside(root, real)) continue; // symlink pointing outside the workspace
      if (!fs.statSync(real).isDirectory()) continue;
      if (isGitRepo(real)) {
        out.push({ name: path.relative(root, full), dir: real });
      } else if (level < depth) {
        walk(full, level + 1);
      }
    }
  };
  walk(root, 1);
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function describeProject(cfg, name, dir, { withStatus = true } = {}) {
  const ov = projectOverrides(cfg, name);
  const setup = detectClaudeSetup(dir);
  const remote = remoteUrlFast(dir);
  let def = null;
  try { def = await defaultBranch(dir, ov.default_branch); } catch { /* ignore */ }
  let dirty = null;
  if (withStatus) {
    try {
      const st = await workingTreeStatus(dir, { includeUntracked: !ov.allow_untracked, timeoutMs: 15_000 });
      dirty = st.dirty;
    } catch { dirty = null; }
  }
  return {
    name,
    note: ov.note || undefined,
    path: dir,
    vcs: 'git',
    current_branch: currentBranchFast(dir) ?? '(detached)',
    default_branch: def,
    remote,
    dirty,
    ...setup,
    compose: findComposeFiles(dir),
    overrides: Object.keys(ov).length ? ov : undefined,
  };
}

export class ProjectIndex {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = null;
    this.scannedAt = 0;
  }

  async scan() {
    const root = realWorkspaceRoot(this.cfg);
    const { depth, exclusions } = this.cfg.discovery;
    const dirs = listCandidateDirs(root, depth, exclusions);
    const projects = await mapLimit(dirs, 8, ({ name, dir }) => describeProject(this.cfg, name, dir));
    projects.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = projects;
    this.scannedAt = Date.now();
    return projects;
  }

  async list({ refresh = true } = {}) {
    if (!refresh && this.cache) return this.cache;
    return this.scan();
  }

  invalidate() { this.cache = null; }
}
