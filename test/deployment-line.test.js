// Deployment profile (config `deployment`): jobs work in the bridge's own worktree, start from the project's
// line (the worktree other sessions work in), are merged back fast-forward and pushed to one branch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobManager } from '../src/jobs.js';
import { DEFAULTS } from '../src/config.js';
import { setPushGuard, run } from '../src/git.js';
import { assertPushAllowed, assertDeployAllowed, validateDeployment, jobGitEnv, workingCopyPath } from '../src/deployment.js';

const ORIGINAL = 'testing/passkeys';
const PUSH = 'feature/copy';
const WORK = 'bridge/copy-line';
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t, { line = true, pushed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-line-'));
  const ws = path.join(root, 'ws'); fs.mkdirSync(ws);
  t.after(() => { setPushGuard(null); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(ws, 'app'); fs.mkdirSync(repo);
  const origin = path.join(root, 'app-origin.git');
  sh(repo, 'init', '-q', '-b', ORIGINAL);
  sh(repo, 'config', 'user.name', 'Test'); sh(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'original\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'initial');
  execFileSync('git', ['init', '--bare', '-q', '-b', ORIGINAL, origin]);
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', 'origin', ORIGINAL);
  // The line: another session's worktree, three commits of local work ahead of the original branch.
  const live = path.join(root, 'live-app');
  if (line) {
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature/local-work', live, ORIGINAL);
    fs.writeFileSync(path.join(live, 'local.txt'), 'only on this deployment\n');
    sh(live, 'add', '.'); sh(live, 'commit', '-qm', 'local work');
    if (pushed) sh(live, 'push', '-q', 'origin', `HEAD:refs/heads/${PUSH}`);
  }
  const cfg = {
    ...structuredClone(DEFAULTS), workspace_root: ws, data_dir: path.join(root, 'jobs'),
    deployment: { name: 'copy', site: 'copy.example', push_branch: PUSH, work_branch: WORK, base_ref: `origin/${ORIGINAL}`, forbidden_push_branches: [ORIGINAL, 'main', 'master'], forbidden_commands: ['/original/deploy.sh'], job_push_block: [root] },
    projects: { app: line ? { line: { worktree: live, branch: 'feature/local-work' } } : {} },
  };
  const m = new JobManager(cfg, {}, { log: { info() {}, error() {}, warn() {} } });
  t.after(() => { for (const timer of m.writeTimers.values()) clearTimeout(timer); });
  const work = path.join(ws, '.bridge-lines', 'app');
  const originSha = ref => { try { return sh(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`); } catch { return null; } };
  return { m, cfg, root, repo, origin, live, work, originSha };
}

const MODEL_USAGE = { 'claude-opus-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 1 } };
const result = (m, job, text) => m.handleEvent(job, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 1, modelUsage: MODEL_USAGE, result: text }));
/** A stand-in agent: runs `work(job)` in the job's directory and reports a result. */
const agent = (f, work) => { f.m.spawnClaude = async job => { await work?.(job); result(f.m, job, 'done'); return { code: 0 }; }; };
const commitIn = (dir, file, content, msg = file) => { fs.writeFileSync(path.join(dir, file), content); sh(dir, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'add', file); sh(dir, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '-qm', msg); return sh(dir, 'rev-parse', 'HEAD'); };
async function finished(m, id) {
  for (let i = 0; i < 400 && ['queued', 'running'].includes(m.get(id).state); i++) await new Promise(r => setTimeout(r, 25));
  return m.get(id);
}

test('the only push the profile allows is a plain update of its push branch', () => {
  const cfg = { deployment: { name: 'copy', push_branch: PUSH, forbidden_push_branches: [ORIGINAL, 'main', 'master'] } };
  assert.doesNotThrow(() => assertPushAllowed(cfg, ['push', '--quiet', 'origin', `abc123:refs/heads/${PUSH}`]));
  assert.doesNotThrow(() => assertPushAllowed(cfg, ['-c', 'x=y', 'push', 'origin', `HEAD:${PUSH}`]));
  for (const bad of [
    ['push', 'origin', `HEAD:${ORIGINAL}`], ['push', 'origin', `HEAD:refs/heads/${ORIGINAL}`], ['push', 'origin', 'HEAD:main'], ['push', 'origin', 'HEAD:refs/heads/master'],
    ['push', '--quiet', '-u', 'origin', `${ORIGINAL}:${ORIGINAL}`], ['push', 'origin', `+HEAD:${PUSH}`], ['push', '--force', 'origin', `HEAD:${PUSH}`],
    ['push', '--force-with-lease', 'origin', `HEAD:${PUSH}`], ['push', 'origin', `:${PUSH}`], ['push', '--delete', 'origin', PUSH], ['push', 'origin'], ['push'],
    ['push', '--all', 'origin'], ['push', '--mirror', 'origin'], ['push', 'origin', PUSH, `HEAD:${ORIGINAL}`], ['push', 'origin', 'HEAD:bridge/other'], ['push', 'origin', `HEAD:refs/tags/${PUSH}`],
  ]) assert.throws(() => assertPushAllowed(cfg, bad), /refused/, bad.join(' '));
  // No profile: nothing is checked (the original behaviour).
  assert.doesNotThrow(() => assertPushAllowed({}, ['push', 'origin', 'HEAD:main']));
});

test('a profile that could push to a forbidden branch or run a forbidden deploy command does not load', t => {
  const base = { deployment: { name: 'copy', push_branch: PUSH, forbidden_push_branches: [ORIGINAL], forbidden_commands: ['/original/deploy.sh'] } };
  assert.doesNotThrow(() => validateDeployment({ ...base, projects: { app: { deploy: { command: ['/copy/deploy.sh'] } } } }));
  assert.throws(() => validateDeployment({ ...base, projects: { app: { deploy: { command: ['/original/deploy.sh'] } } } }), /projects\.app\.deploy\.command.*must not be run/);
  assert.throws(() => validateDeployment({ ...base, projects: { app: { deploy: { command: 'cd /x && /original/deploy.sh app' } } } }), /must not be run/);
  assert.throws(() => validateDeployment({ deployment: { push_branch: ORIGINAL, forbidden_push_branches: [ORIGINAL] } }), /forbidden_push_branches/);
  assert.throws(() => assertDeployAllowed(base, ['/bin/sh', '-c', '/original/deploy.sh']), /refused/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-line-')); t.after(() => { setPushGuard(null); fs.rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => new JobManager({ ...structuredClone(DEFAULTS), workspace_root: root, data_dir: path.join(root, 'j'), ...base, projects: { app: { deploy: { command: ['/original/deploy.sh'] } } } }, {}, { log: { info() {}, error() {}, warn() {} } }), /must not be run/);
});

test('an execute job starts from the line, is merged back fast-forward and pushed to the push branch only', async t => {
  const f = fixture(t);
  const originalBefore = f.originSha(ORIGINAL);
  const mainHead = sh(f.repo, 'rev-parse', 'HEAD');
  // Another session is mid-edit in the line worktree, in a file the job does not touch.
  fs.writeFileSync(path.join(f.live, 'theirs.txt'), 'someone else, uncommitted\n');
  let seen;
  agent(f, job => { seen = { cwd: job.project_path, local: fs.existsSync(path.join(job.project_path, 'local.txt')), branch: sh(job.project_path, 'rev-parse', '--abbrev-ref', 'HEAD') }; commitIn(job.project_path, 'job.txt', 'from the job\n'); });
  const started = await f.m.start({ project: 'app', prompt: 'Add a file', mode: 'execute', base_branch: ORIGINAL });
  assert.equal(started.pushes_to, PUSH);
  assert.match(started.note, /base_branch testing\/passkeys is not used/);
  const job = await finished(f.m, started.job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.deepEqual(seen, { cwd: f.work, local: true, branch: WORK }, 'the agent worked in the bridge worktree, on the line\'s code');
  assert.equal(job.commits, 1); assert.equal(job.pushed, true); assert.equal(job.push_target, PUSH);
  const head = sh(f.work, 'rev-parse', 'HEAD');
  assert.equal(sh(f.live, 'rev-parse', 'HEAD'), head, 'the line was fast-forwarded');
  assert.equal(sh(f.live, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/local-work');
  assert.equal(fs.readFileSync(path.join(f.live, 'job.txt'), 'utf8'), 'from the job\n');
  assert.equal(fs.readFileSync(path.join(f.live, 'theirs.txt'), 'utf8'), 'someone else, uncommitted\n', 'their uncommitted file is untouched');
  assert.equal(f.originSha(PUSH), head);
  assert.equal(f.originSha(ORIGINAL), originalBefore, 'the original branch on origin did not move');
  assert.equal(f.originSha(WORK), null, 'the working branch is never pushed');
  assert.equal(sh(f.repo, 'rev-parse', 'HEAD'), mainHead, 'the workspace checkout was not used');
  assert.equal(sh(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), ORIGINAL);
  assert.match(f.m.systemPrompt(job, { remote: true }), /Never push: pushes from this job are switched off/);
  assert.match(f.m.systemPrompt(job, { remote: true }), /testing\/passkeys, main, master must never be written/);
});

test('when the line moved while the job ran, its commits are rebased onto it; a conflict is refused and nothing is published', async t => {
  const f = fixture(t);
  agent(f, job => { commitIn(job.project_path, 'job.txt', 'job\n'); commitIn(f.live, 'peer.txt', 'peer\n'); });
  let job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'One', mode: 'execute' })).job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.ok(job.notes.some(n => /line moved while the job ran/.test(n)));
  assert.equal(sh(f.live, 'rev-parse', 'HEAD'), sh(f.work, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(f.live, 'job.txt')) && fs.existsSync(path.join(f.live, 'peer.txt')));
  assert.equal(f.originSha(PUSH), sh(f.live, 'rev-parse', 'HEAD'));

  const pushedBefore = f.originSha(PUSH);
  let peerHead;
  agent(f, job => { commitIn(job.project_path, 'file.txt', 'the job\'s version\n'); peerHead = commitIn(f.live, 'file.txt', 'the peer\'s version\n'); });
  job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'Two', mode: 'execute' })).job_id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'line_conflict');
  assert.match(job.error, /moved while the job ran.*conflicts in file\.txt.*Nothing was merged into the line, pushed or deployed/s);
  assert.equal(sh(f.live, 'rev-parse', 'HEAD'), peerHead, 'the line is as the peer left it');
  assert.equal(f.originSha(PUSH), pushedBefore, 'nothing reached origin');
  assert.ok(sh(f.repo, 'rev-parse', job.rescue_ref), 'the job\'s commit is kept');
  assert.ok(!job.deploy, 'and nothing was deployed');

  // The next job is not blocked by the stranded commit: it is set aside and the job starts from the line.
  agent(f, job => { assert.equal(fs.readFileSync(path.join(job.project_path, 'file.txt'), 'utf8'), 'the peer\'s version\n'); commitIn(job.project_path, 'three.txt', '3\n'); });
  job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'Three', mode: 'execute' })).job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.ok(job.notes.some(n => /set aside at rescue\/bridge-/.test(n)));
  assert.equal(f.originSha(PUSH), sh(f.live, 'rev-parse', 'HEAD'));
});

test('uncommitted edits in the line worktree are never overwritten: the merge is refused and the commits go out with a later job', async t => {
  const f = fixture(t);
  const pushedBefore = f.originSha(PUSH);
  const lineBefore = sh(f.live, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.live, 'local.txt'), 'a peer is editing this right now\n');
  agent(f, job => commitIn(job.project_path, 'local.txt', 'the job changed the same file\n'));
  let job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'Same file', mode: 'execute' })).job_id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'line_merge_refused');
  assert.match(job.error, /could not fast-forward.*Nothing was pushed or deployed/s);
  assert.equal(fs.readFileSync(path.join(f.live, 'local.txt'), 'utf8'), 'a peer is editing this right now\n');
  assert.equal(sh(f.live, 'rev-parse', 'HEAD'), lineBefore);
  assert.equal(f.originSha(PUSH), pushedBefore);
  // The peer commits; the next job carries the earlier commit forward if it still applies (here it conflicts and is set aside).
  sh(f.live, '-c', 'user.name=Peer', '-c', 'user.email=p@example.invalid', 'commit', '-qam', 'peer done');
  agent(f, job => commitIn(job.project_path, 'later.txt', 'later\n'));
  job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'Later', mode: 'execute' })).job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(fs.readFileSync(path.join(f.live, 'local.txt'), 'utf8'), 'a peer is editing this right now\n');
  assert.equal(f.originSha(PUSH), sh(f.live, 'rev-parse', 'HEAD'));
});

test('a plan job reads the line\'s code in the bridge worktree and changes nothing', async t => {
  const f = fixture(t);
  const before = [sh(f.live, 'rev-parse', 'HEAD'), f.originSha(PUSH), f.originSha(ORIGINAL)];
  let seen;
  agent(f, job => { seen = [job.project_path, fs.existsSync(path.join(job.project_path, 'local.txt'))]; });
  const job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'Plan it', mode: 'plan' })).job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.deepEqual(seen, [f.work, true]);
  assert.deepEqual([sh(f.live, 'rev-parse', 'HEAD'), f.originSha(PUSH), f.originSha(ORIGINAL)], before);
  assert.equal(job.line.head, before[0]);
});

test('a line that no longer matches its configuration stops an execute job before anything runs', async t => {
  const f = fixture(t);
  let ran = false; agent(f, () => { ran = true; });
  // The pushed branch is ahead of the configured line: somebody moved on in another worktree.
  const other = path.join(f.root, 'other'); sh(f.repo, 'worktree', 'add', '-q', '-b', 'feature/newer', other, 'feature/local-work');
  commitIn(other, 'newer.txt', 'newer\n'); sh(other, 'push', '-q', 'origin', `HEAD:refs/heads/${PUSH}`);
  let job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'x', mode: 'execute' })).job_id);
  assert.equal(job.error_code, 'line_stale'); assert.match(job.error, /behind what was pushed/);
  // The line worktree was switched to another branch.
  sh(f.live, 'merge', '-q', '--ff-only', 'feature/newer'); sh(f.live, 'checkout', '-q', '-b', 'feature/something-else');
  job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'y', mode: 'execute' })).job_id);
  assert.equal(job.error_code, 'line_stale'); assert.match(job.error, /is on feature\/something-else, not on feature\/local-work/);
  assert.equal(ran, false);
});

test('a project without a line worktree starts from the read-only base and creates the push branch; a disabled project is refused', async t => {
  const f = fixture(t, { line: false });
  agent(f, job => commitIn(job.project_path, 'docs.md', 'note\n'));
  const job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'docs', mode: 'execute' })).job_id);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(f.originSha(PUSH), sh(f.work, 'rev-parse', 'HEAD'));
  assert.equal(f.originSha(ORIGINAL), sh(f.repo, 'rev-parse', ORIGINAL));
  f.cfg.projects.app = { line: { disabled: 'its live code is not in this workspace' } };
  await assert.rejects(f.m.start({ project: 'app', prompt: 'again', mode: 'plan' }), /not available for bridge jobs on this deployment.*not in this workspace/);
  await assert.rejects(f.m.startExperiment({ project: 'app' }), /experiments are not available/);
});

test('the deploy command gets the line and push branch, and a forbidden command never runs', async t => {
  const f = fixture(t);
  const out = path.join(f.root, 'deploy-env.txt');
  f.cfg.projects.app.deploy = { auto: true, command: ['/bin/sh', '-c', `echo "$BRIDGE_PUSH_BRANCH|$BRIDGE_LINE_WORKTREE|$BRIDGE_PROJECT_PATH|$BRIDGE_SHA|$BRIDGE_START_SHA" > ${out}; echo "== live"`] };
  const lineBefore = sh(f.live, 'rev-parse', 'HEAD');
  agent(f, job => commitIn(job.project_path, 'a.txt', 'a\n'));
  let job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'deploy me', mode: 'execute' })).job_id);
  assert.equal(job.deploy.state, 'deployed');
  assert.match(job.result_text, /Deployed to copy\.example/);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), [PUSH, f.live, f.work, sh(f.work, 'rev-parse', 'HEAD'), lineBefore].join('|'));
  // Somebody edits the running configuration object to the other deployment's script: still refused at the last step.
  f.cfg.projects.app.deploy = { auto: true, command: ['/original/deploy.sh'] };
  agent(f, job => commitIn(job.project_path, 'b.txt', 'b\n'));
  job = await finished(f.m, (await f.m.start({ project: 'app', prompt: 'deploy me again', mode: 'execute' })).job_id);
  assert.equal(job.state, 'completed');
  assert.equal(job.deploy.state, 'failed');
  assert.match(job.result_text, /NOT deployed: refused: \/original\/deploy\.sh must not be run on this deployment/);
});

test('the bridge itself cannot push anywhere else, and a push from the agent\'s own shell goes nowhere', async t => {
  const f = fixture(t);
  await assert.rejects(run('git', ['push', 'origin', `HEAD:${ORIGINAL}`], { cwd: f.live }), /refused: on this deployment \(copy\) the bridge pushes only to feature\/copy/);
  await assert.rejects(run('git', ['push', '--quiet', '-u', 'origin', `${ORIGINAL}:${ORIGINAL}`], { cwd: f.repo }), /refused/);
  const env = jobGitEnv(f.cfg);
  const before = f.originSha(PUSH);
  commitIn(f.live, 'sneaky.txt', 'x\n');
  for (const dst of [PUSH, ORIGINAL, 'main']) {
    assert.throws(() => execFileSync('git', ['push', 'origin', `HEAD:${dst}`], { cwd: f.live, env: { ...process.env, ...env }, stdio: 'pipe' }), 'push with the job environment fails');
  }
  assert.equal(f.originSha(PUSH), before); assert.equal(f.originSha('main'), null);
  assert.equal(workingCopyPath(f.cfg, 'app'), f.work);
});
