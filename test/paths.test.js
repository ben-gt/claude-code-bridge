import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitiseName, cloneDestination, resolveProjectDir, BoundaryError } from '../src/paths.js';
import { normaliseSource } from '../src/clone.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ws-'));
fs.mkdirSync(path.join(root, 'proj'));
fs.mkdirSync(path.join(root, 'proj', '.git'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-out-'));
fs.symlinkSync(outside, path.join(root, 'escape'));
const cfg = { workspace_root: root, clone: { hosts: [{ host: 'github.com', type: 'github' }] } };

test('sanitiseName rejects traversal, separators, absolute paths, leading dots', () => {
  for (const bad of ['../x', '..', 'a/b', 'a\\b', '/etc', '.hidden', 'a..b', '', ' ', 'weird name', 'x\0y']) {
    assert.throws(() => sanitiseName(bad), BoundaryError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(sanitiseName('my-repo.git'), 'my-repo');
  assert.equal(sanitiseName('Repo_1.2'), 'Repo_1.2');
});

test('cloneDestination is always a direct child of the root', () => {
  const d = cloneDestination(cfg, 'newrepo');
  assert.equal(path.dirname(d.dest), fs.realpathSync(root));
  assert.throws(() => cloneDestination(cfg, '../newrepo'), BoundaryError);
});

test('resolveProjectDir enforces the boundary after symlink resolution', () => {
  assert.equal(resolveProjectDir(cfg, 'proj'), fs.realpathSync(path.join(root, 'proj')));
  assert.throws(() => resolveProjectDir(cfg, 'escape'), /outside/);
  assert.throws(() => resolveProjectDir(cfg, '../'), /outside|not found/);
  assert.throws(() => resolveProjectDir(cfg, '/etc'), /outside/);
  assert.throws(() => resolveProjectDir(cfg, '.'), /outside/);
});

test('normaliseSource accepts https/ssh/scp and owner/repo, rejects the rest', () => {
  assert.equal(normaliseSource(cfg, { url: 'https://user:tok@github.com/o/r.git' }).cloneUrl, 'https://github.com/o/r.git');
  assert.equal(normaliseSource(cfg, { url: 'https://github.com/o/r' }).suggestedName, 'r');
  assert.equal(normaliseSource(cfg, { url: 'git@github.com:o/r.git' }).scheme, 'ssh');
  assert.equal(normaliseSource(cfg, { url: 'ssh://git@host:2222/o/r.git' }).host, 'host');
  assert.equal(normaliseSource(cfg, { repo: 'o/r' }).cloneUrl, 'https://github.com/o/r.git');
  for (const bad of ['file:///etc', 'http://github.com/o/r', 'git://github.com/o/r', '/root/code/x', 'ext::sh -c whoami', '../x']) {
    assert.throws(() => normaliseSource(cfg, { url: bad }), BoundaryError, `should reject ${bad}`);
  }
  assert.throws(() => normaliseSource(cfg, { repo: '../x' }), BoundaryError);
});
