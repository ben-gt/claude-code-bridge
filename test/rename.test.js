import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingBridgePath, DEFAULTS } from '../src/config.js';

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-bridge-rename-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('fresh installations use code-bridge names and protect both installation names', () => {
  assert.equal(path.basename(DEFAULTS.data_dir), 'code-bridge');
  assert.equal(path.basename(path.dirname(DEFAULTS.server.token_file)), 'code-bridge');
  for (const name of ['code-bridge', 'claude-code-bridge']) {
    assert.ok(DEFAULTS.discovery.exclusions.includes(name));
    assert.ok(DEFAULTS.compose.protected.includes(name));
  }
});

for (const [current, legacy] of [
  ['.local/share/code-bridge', '.local/share/claude-code-bridge'],
  ['.config/code-bridge/token', '.config/claude-code-bridge/token'],
]) {
  test(`upgrade preserves ${legacy} and respects new or custom paths`, t => {
    const home = temporaryHome(t);
    const configured = path.join(home, current);
    const old = path.join(home, legacy);
    const resolve = value => existingBridgePath(value, current, legacy, home);
    assert.equal(resolve(configured), configured, 'fresh install');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'existing state');
    assert.equal(resolve(configured), old, 'reuse legacy state');
    const custom = path.join(home, 'custom');
    assert.equal(resolve(custom), custom, 'never override explicit custom paths');
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    fs.writeFileSync(configured, 'new state');
    assert.equal(resolve(configured), configured, 'existing new path takes priority');
    assert.equal(fs.readFileSync(old, 'utf8'), 'existing state', 'no migration writes');
  });
}

test('idle check blocks active jobs and fails when status is unavailable or malformed', t => {
  const dir = temporaryHome(t);
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(new URL('../scripts/check-idle.sh', import.meta.url), path.join(scripts, 'check-idle.sh'));
  const mock = path.join(scripts, 'mcp-call.sh');
  for (const [body, code] of [
    ['echo \'{"jobs":[]}\'', 0],
    ['echo \'{"jobs":[{"job_id":"j_active"}]}\'', 2],
    ['echo \'{"jobs":[],"active_integrations":1}\'', 2],
    ['echo \'{"jobs":[],"active_integrations":0}\'', 0],
    ['exit 7', 1],
    ['echo \'{"unexpected":true}\'', 1],
    ['echo broken-json', 1],
    ['case "$2" in *queued*) echo \'{"jobs":[{}]}\';; *) echo \'{"jobs":[]}\';; esac', 2],
  ]) {
    fs.writeFileSync(mock, `#!/bin/sh\n${body}\n`);
    const result = spawnSync('sh', [path.join(scripts, 'check-idle.sh')], { encoding: 'utf8' });
    assert.equal(result.status, code, body);
  }
});
