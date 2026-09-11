import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs.js';
import { codexArgs } from '../src/codex.js';

const guidelinesUrl = new URL('../AGENTS.md', import.meta.url);

function manager(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-instructions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new JobManager({ data_dir: dir, claude: {}, codex: {} }, { all: () => [] });
}

function job(kind, mode) {
  return {
    id: 'j_instructions', kind, mode, project: 'another-repo',
    project_path: '/unrelated/project', worktree: '/unrelated/worktree',
    prompt: 'Review the implementation', branch: 'bridge/test', base_branch: 'main',
    limits: { max_cost_usd: 5, timeout_minutes: 30 },
    setup: { preflight: true },
  };
}

for (const kind of ['claude', 'codex']) {
  for (const mode of ['plan', 'execute']) {
    test(`${kind} ${mode} command receives master guidelines and job constraints`, t => {
      const m = manager(t);
      const j = job(kind, mode);
      const args = kind === 'claude'
        ? m.claudeArgs(j, { remote: true })
        : codexArgs(j, m.cfg, { instructions: m.systemPrompt(j, { remote: true }) });
      const instructions = kind === 'claude'
        ? args[args.indexOf('--append-system-prompt') + 1]
        : JSON.parse(args.find(a => a.startsWith('developer_instructions=')).slice('developer_instructions='.length));
      const guidelines = fs.readFileSync(guidelinesUrl, 'utf8').trim();
      assert.ok(instructions.includes(guidelines), 'full bridge file reaches the engine');
      assert.equal(instructions.split(guidelines).length, 2, 'included once');
      assert.match(instructions, /DRY: Don't Repeat Yourself/);
      assert.match(instructions, /JPL Power of Ten Alignment/);
      assert.match(instructions, /More specific project conventions take precedence/);
      assert.match(instructions, /bridge job constraints below take precedence/);
      assert.match(instructions, new RegExp(`This is ${mode.toUpperCase()} mode`));
      if (mode === 'execute') assert.match(instructions, /checklist in \.claude\/preflight\.md/);
      else assert.match(instructions, /Do not attempt to create, write or save ANY file/);
    });
  }
}

test('subsequent jobs read updated guidelines without recreating the manager', t => {
  const m = manager(t);
  const read = fs.readFileSync.bind(fs);
  let contents = '# Shared rules\nFirst version';
  t.mock.method(fs, 'readFileSync', (file, ...args) =>
    String(file) === String(guidelinesUrl) ? contents : read(file, ...args));
  assert.match(m.systemPrompt(job('claude', 'plan'), {}), /First version/);
  contents = '# Shared rules\nUpdated version';
  const next = m.systemPrompt(job('codex', 'plan'), {});
  assert.match(next, /Updated version/);
  assert.doesNotMatch(next, /First version/);
});

test('missing, unreadable, or empty guidelines prevent command construction', t => {
  const m = manager(t);
  const read = fs.readFileSync.bind(fs);
  let failure = 'ENOENT';
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file) !== String(guidelinesUrl)) return read(file, ...args);
    if (!failure) return ' \n ';
    throw Object.assign(new Error(`${failure}: bridge AGENTS.md`), { code: failure });
  });
  for (const code of ['ENOENT', 'EACCES', null]) {
    failure = code;
    assert.throws(() => m.claudeArgs(job('claude', 'plan'), {}), code ? { code } : /AGENTS.md is empty/);
  }
});
