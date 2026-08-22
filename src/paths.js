// Workspace boundary enforcement. Every path check happens AFTER realpath resolution,
// so symlinks and '..' can't escape the workspace root.
import fs from 'node:fs';
import path from 'node:path';

export class BoundaryError extends Error {
  constructor(msg) { super(msg); this.name = 'BoundaryError'; }
}

export function realWorkspaceRoot(cfg) {
  return fs.realpathSync(cfg.workspace_root);
}

/** True if `resolved` (already realpath'd) is the root or strictly inside it. */
export function isInside(root, resolved) {
  const rel = path.relative(root, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a project name (or path) to a real directory inside the workspace.
 * Throws BoundaryError if it resolves outside, or if it doesn't exist.
 */
export function resolveProjectDir(cfg, nameOrPath) {
  const root = realWorkspaceRoot(cfg);
  if (typeof nameOrPath !== 'string' || !nameOrPath.trim()) throw new BoundaryError('project is required');
  const candidate = path.isAbsolute(nameOrPath) ? nameOrPath : path.join(root, nameOrPath);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new BoundaryError(`project not found: ${nameOrPath}`);
  }
  if (!isInside(root, real) || real === root) {
    throw new BoundaryError(`refused: ${nameOrPath} resolves outside the workspace root`);
  }
  if (!fs.statSync(real).isDirectory()) throw new BoundaryError(`not a directory: ${nameOrPath}`);
  return real;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Sanitise a clone destination name. Returns the cleaned name or throws.
 * Rules: no separators, no traversal, no leading dot, sane charset, strips a trailing .git.
 */
export function sanitiseName(raw) {
  if (typeof raw !== 'string') throw new BoundaryError('name must be a string');
  let name = raw.trim();
  if (name.endsWith('.git')) name = name.slice(0, -4);
  if (!name) throw new BoundaryError('name is empty');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) throw new BoundaryError(`refused: name "${raw}" contains a path separator`);
  if (name === '.' || name === '..' || name.includes('..')) throw new BoundaryError(`refused: name "${raw}" contains traversal`);
  if (name.startsWith('.')) throw new BoundaryError(`refused: name "${raw}" starts with a dot`);
  if (!NAME_RE.test(name)) throw new BoundaryError(`refused: name "${raw}" has unsupported characters (allowed: letters, digits, . _ -)`);
  return name;
}

/** Compute the destination for a clone and verify it's a direct child of the workspace root. */
export function cloneDestination(cfg, name) {
  const root = realWorkspaceRoot(cfg);
  const clean = sanitiseName(name);
  const dest = path.join(root, clean);
  // dest doesn't exist yet (usually) so realpath the parent instead.
  const parentReal = fs.realpathSync(path.dirname(dest));
  if (parentReal !== root) throw new BoundaryError('refused: destination is not directly under the workspace root');
  return { root, name: clean, dest };
}
