// A job's install in its isolated checkout rewrites package-lock.json; that must not be published as work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restoreLockChurn } from '../src/jobs.js';
import { workingTreeStatus } from '../src/git.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'web'));
  for (const d of ['', 'web']) {
    fs.writeFileSync(path.join(dir, d, 'package.json'), '{"dependencies":{}}\n');
    fs.writeFileSync(path.join(dir, d, 'package-lock.json'), '{"lockfileVersion":3}\n');
  }
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const a = 1;\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  return { dir, g };
}

test('a lock file that changed without its manifest is restored; real edits are kept', async () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"churn":true}\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const a = 2;\n');
  const restored = await restoreLockChurn(dir, (await workingTreeStatus(dir)).entries);
  assert.deepEqual(restored, ['package-lock.json']);
  assert.equal(g('status', '--porcelain').trim(), 'M app.js');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lock file that changed with its manifest is kept, per directory', async () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"x":"1.0.0"}}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":true}\n');
  fs.writeFileSync(path.join(dir, 'web', 'package-lock.json'), '{"lockfileVersion":3,"churn":true}\n');
  const restored = await restoreLockChurn(dir, (await workingTreeStatus(dir)).entries);
  assert.deepEqual(restored, ['web/package-lock.json']);
  assert.match(g('status', '--porcelain'), /M package-lock\.json/);
  assert.doesNotMatch(g('status', '--porcelain'), /web\/package-lock\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing but lock churn leaves a clean tree, so no leftover commit is made', async () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"churn":true}\n');
  await restoreLockChurn(dir, (await workingTreeStatus(dir)).entries);
  assert.equal(g('status', '--porcelain').trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
