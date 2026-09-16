import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { validateTaskBase } from '../src/task-branches.js';
import { registerTools } from '../src/tools.js';

const quiet = { info() {}, warn() {}, error() {} };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-branches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'app');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial');
  git('checkout', '-b', 'testing/passkeys');
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local change');
  const cfg = { ...structuredClone(DEFAULTS), workspace_root: root, data_dir: path.join(root, 'data') };
  const manager = new JobManager(cfg, {}, { log: quiet });
  manager.pump = () => {};
  return { manager, cfg, git, args: { project: 'app', prompt: 'Fix the crash. Branch off testing/passkeys, never main.', mode: 'execute' } };
}

test('execute cannot select its base through prose or inferred main', async t => {
  const { manager, args } = fixture(t);
  await assert.rejects(manager.start(args), /explicit base_branch/);
  assert.equal(manager.jobs.size, 0);
  assert.deepEqual(fs.readdirSync(manager.jobsDir), []);
});

test('dispatch pins and reports base and original checkout status before launching', async t => {
  const { manager, args, git } = fixture(t);
  const result = await manager.start({ ...args, base_branch: 'testing/passkeys' });
  assert.equal(result.base_branch, 'testing/passkeys');
  assert.equal(result.checkout_status.branch, 'testing/passkeys');
  assert.deepEqual(result.checkout_status.status_entries, ['?? local.txt']);
  assert.equal(result.checkout_status.total_entries, 1);
  git('checkout', 'main');
  assert.equal(manager.status(result.job_id).base_branch, 'testing/passkeys');
  const saved = JSON.parse(fs.readFileSync(manager.recordFile(result.job_id), 'utf8'));
  assert.equal(saved.base_branch, 'testing/passkeys');
});

test('project policy rejects wrong bases and is checked again at launch', async t => {
  const { manager, cfg, args } = fixture(t);
  cfg.projects.app = { allowed_base_branches: ['testing/passkeys'] };
  await assert.rejects(manager.start({ ...args, base_branch: 'main' }), /not allowed/);
  const result = await manager.start({ ...args, base_branch: 'testing/passkeys' });
  cfg.projects.app.allowed_base_branches = ['testing/next'];
  await assert.rejects(manager.runJob(manager.get(result.job_id)), /not allowed/);
  assert.equal(fs.existsSync(path.join(cfg.data_dir, 'worktrees')), false);
});

test('plan mode remains read-only without a base; malformed bases and policies fail closed', () => {
  assert.equal(validateTaskBase({}), null);
  assert.equal(validateTaskBase({ mode: 'plan', base_branch: 'main' }, { allowed_base_branches: ['testing/passkeys'] }), 'main');
  for (const base of ['', 'HEAD', '-main', 'refs/../main', 'main.lock', 'a//b', 'a/.b', 'main~1', 42]) {
    assert.throws(() => validateTaskBase({ mode: 'execute', base_branch: base }), /invalid base_branch/);
  }
  for (const allowed of [[], 'main', ['bad..branch'], Array(51).fill('main')]) {
    assert.throws(() => validateTaskBase({ mode: 'execute', base_branch: 'main' }, { allowed_base_branches: allowed }), /allowed_base_branches/);
  }
});

test('MCP dispatch headline contains selected base, with structured checkout metadata', async t => {
  const { manager, cfg, args } = fixture(t);
  const handlers = new Map();
  registerTools({ registerTool(name, config, handler) { handlers.set(name, handler); } }, { cfg, jobs: manager, projects: {}, log: quiet });
  const denied = await handlers.get('start_task')(args);
  assert.equal(denied.isError, true);
  const result = await handlers.get('start_task')({ ...args, base_branch: 'testing/passkeys' });
  assert.match(result.content[0].text, /base testing\/passkeys/);
  assert.equal(result.structuredContent.base_branch, 'testing/passkeys');
  assert.equal(result.structuredContent.checkout_status.dirty, true);
});
