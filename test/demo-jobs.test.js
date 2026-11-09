import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {JobManager} from '../src/jobs.js';
import {DEFAULTS} from '../src/config.js';
import {describeProject} from '../src/projects.js';
import {registerTools} from '../src/tools.js';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'demo-bridge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const repo=path.join(root,'app');fs.mkdirSync(repo);const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'}).trim();git('init','-q','-b','testing/passkeys');git('config','user.name','Test');git('config','user.email','test@example.invalid');fs.writeFileSync(path.join(repo,'file.txt'),'before');git('add','.');git('commit','-qm','initial');const cfg={...structuredClone(DEFAULTS),workspace_root:root,data_dir:path.join(root,'.jobs'),execution_branch:'testing/passkeys'};const m=new JobManager(cfg,{}, {log:{info(){},error(){},warn(){}}});m.pump=()=>{};t.after(()=>{for(const timer of m.writeTimers.values())clearTimeout(timer);});return {m,git,repo};
}
test('demo rejects other base branches before starting',async t=>{const {m}=fixture(t);for(const base_branch of ['main','master','feature/x'])await assert.rejects(m.start({project:'app',prompt:'Fix',mode:'execute',base_branch}),/only permits/);});
test('plan mode disables shell writes as well as edit tools',async t=>{const {m}=fixture(t);const r=await m.start({project:'app',prompt:'Review'});const args=m.claudeArgs(m.jobs.get(r.job_id),{remote:false});assert.ok(args.includes('Bash'));assert.ok(args.includes('Write'));assert.ok(args.includes('Edit'));});
test('queued ticket evidence persists across service restart and is passed to Claude',async t=>{const {m}=fixture(t);const r=await m.start({project:'app',prompt:'Review',ticket_context:{ticket_id:'JERYYMKT',text:'Details',attachments:[{filename:'proof.txt',data_base64:Buffer.from('proof').toString('base64')}]}});const j=m.jobs.get(r.job_id);assert.equal(fs.readFileSync(path.join(j.ticket_input.directory,'1-proof.txt'),'utf8'),'proof');assert.ok(m.claudeArgs(j,{remote:false}).includes(j.ticket_input.directory));const restored=new JobManager(m.cfg,{}, {log:{info(){},warn(){},error(){}}});restored.init();assert.equal(restored.jobs.get(j.id).ticket_input.ticket_id,'JERYYMKT');});
test('execute keeps testing branch and records local commits without a PR',async t=>{const {m,git,repo}=fixture(t);const r=await m.start({project:'app',prompt:'Fix JERYYMKT',mode:'execute'});const j=m.jobs.get(r.job_id);j.state='running';m.spawnClaude=async()=>{fs.writeFileSync(path.join(repo,'file.txt'),'after');return {code:0};};m.openDraftPr=()=>{throw new Error('Must never create a PR');};await m.runJob(j);assert.equal(j.state,'completed');assert.equal(j.branch,'testing/passkeys');assert.equal(j.commits,1);assert.equal(git('branch','--show-current'),'testing/passkeys');assert.equal(git('branch','--list').includes('bridge/'),false);});
test('empty job keeps the demo branch',async t=>{const {m,git}=fixture(t);const r=await m.start({project:'app',prompt:'Check',mode:'execute'});const j=m.jobs.get(r.job_id);j.state='running';m.spawnClaude=async()=>({code:0});await m.runJob(j);assert.equal(j.commits,0);assert.equal(git('branch','--show-current'),'testing/passkeys');});
test('queued jobs cannot commit changes someone added after queueing',async t=>{const {m,repo}=fixture(t);const r=await m.start({project:'app',prompt:'Check',mode:'execute'});const j=m.jobs.get(r.job_id);j.state='running';fs.writeFileSync(path.join(repo,'other.txt'),'preserve');m.spawnClaude=()=>{throw new Error('Must not run');};await m.runJob(j);assert.equal(j.state,'failed');assert.equal(fs.readFileSync(path.join(repo,'other.txt'),'utf8'),'preserve');});

function remoteFixture(t) {
  const f = fixture(t);
  const root = path.dirname(f.repo);
  const origin = path.join(root, 'origin.git');
  const peer = path.join(root, 'peer');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'testing/passkeys', origin]);
  f.git('remote', 'add', 'origin', origin);
  f.git('push', '-qu', 'origin', 'testing/passkeys');
  execFileSync('git', ['clone', '-q', origin, peer]);
  const peerGit = (...args) => execFileSync('git', args, { cwd: peer, encoding: 'utf8' }).trim();
  peerGit('config', 'user.name', 'Test');
  peerGit('config', 'user.email', 'test@example.invalid');
  const commit = (dir, git, file, content) => {
    fs.writeFileSync(path.join(dir, file), content);
    git('add', file); git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  return { ...f, origin, peer, peerGit,
    localCommit: (file, content) => commit(f.repo, f.git, file, content),
    remoteCommit: (file, content) => { const sha = commit(peer, peerGit, file, content); peerGit('push', '-q'); return sha; },
    remoteHead: () => execFileSync('git', ['--git-dir', origin, 'rev-parse', 'testing/passkeys'], { encoding: 'utf8' }).trim(),
  };
}
async function execute(f) {
  const {job_id} = await f.m.start({ project: 'app', prompt: 'Fix', mode: 'execute' });
  const j = f.m.get(job_id); j.state = 'running';
  await f.m.runJob(j);
  return j;
}

test('diverged checkout rebases, preserves original commits and publishes even without new work', async t => {
  const f = remoteFixture(t);
  const local = f.localCommit('local.txt', 'completed work');
  const remote = f.remoteCommit('remote.txt', 'concurrent work');
  let launched = false;
  f.m.spawnClaude = async () => { launched = true; return {code: 0}; };
  const j = await execute(f);
  assert.equal(launched, true);
  assert.equal(j.state, 'completed');
  assert.equal(j.commits, 0);
  assert.equal(j.pushed, true);
  assert.equal(f.git('rev-parse', j.rescue_ref), local);
  assert.equal(f.remoteHead(), f.git('rev-parse', 'HEAD'));
  f.git('merge-base', '--is-ancestor', remote, 'HEAD');
  assert.equal(fs.readFileSync(path.join(f.repo, 'local.txt'), 'utf8'), 'completed work');
  assert.equal(fs.readFileSync(path.join(f.repo, 'remote.txt'), 'utf8'), 'concurrent work');
});

test('behind-only checkout advances before agent starts', async t => {
  const f = remoteFixture(t);
  const remote = f.remoteCommit('remote.txt', 'new');
  f.m.spawnClaude = async () => { assert.equal(f.git('rev-parse', 'HEAD'), remote); return {code: 0}; };
  const j = await execute(f);
  assert.equal(j.state, 'completed');
  assert.equal(j.rescue_ref, null);
});

test('ahead-only checkout publishes commits stranded by an earlier job', async t => {
  const f = remoteFixture(t);
  const local = f.localCommit('local.txt', 'saved');
  f.m.spawnClaude = async () => ({code: 0});
  const j = await execute(f);
  assert.equal(j.pushed, true);
  assert.equal(f.remoteHead(), local);
});

test('conflicting rebase restores checkout, reports named error and never starts the agent', async t => {
  const f = remoteFixture(t);
  const local = f.localCommit('file.txt', 'local conflict');
  f.remoteCommit('file.txt', 'remote conflict');
  f.m.spawnClaude = async () => { assert.fail('must not launch'); };
  const j = await execute(f);
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'checkout_rebase_conflict');
  assert.match(j.error, /app.*testing\/passkeys/);
  assert.match(j.error, /file.txt/);
  assert.equal(f.git('rev-parse', 'HEAD'), local);
  assert.equal(f.git('rev-parse', `rescue/bridge-${j.id}`), local);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('branch', '--show-current'), 'testing/passkeys');
  assert.equal(f.m.status(j.id).error_code, 'checkout_rebase_conflict');
  assert.equal(f.m.list()[0].error_code, 'checkout_rebase_conflict');
});

test('fetch failure is actionable and leaves the checkout intact', async t => {
  const f = remoteFixture(t);
  const head = f.git('rev-parse', 'HEAD');
  f.git('remote', 'set-url', 'origin', path.join(path.dirname(f.repo), 'missing.git'));
  f.m.spawnClaude = async () => { assert.fail('must not launch'); };
  const j = await execute(f);
  assert.equal(j.error_code, 'checkout_fetch_failed');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('timeout pushes existing commits but leaves unfinished staged and untracked work untouched', async t => {
  const f = remoteFixture(t);
  let completed;
  f.m.spawnClaude = async () => {
    completed = f.localCommit('done.txt', 'tested work');
    fs.writeFileSync(path.join(f.repo, 'file.txt'), 'unfinished');
    f.git('add', 'file.txt');
    fs.writeFileSync(path.join(f.repo, 'draft.txt'), 'not tested');
    return {code: null, timedOut: true};
  };
  const j = await execute(f);
  assert.equal(j.state, 'failed');
  assert.equal(j.error_code, 'job_timeout');
  assert.equal(j.pushed, true);
  assert.equal(f.remoteHead(), completed);
  assert.equal(f.git('show', 'HEAD:file.txt'), 'before');
  assert.equal(f.git('show', ':file.txt'), 'unfinished');
  assert.match(f.git('status', '--porcelain'), /\?\? draft.txt/);
  assert.equal(j.commits, 1);
});

test('timeout without commits leaves partial edits uncommitted and does not push', async t => {
  const f = remoteFixture(t);
  const head = f.remoteHead();
  f.m.spawnClaude = async () => { fs.writeFileSync(path.join(f.repo, 'file.txt'), 'partial'); return {timedOut: true}; };
  const j = await execute(f);
  assert.equal(j.commits, 0);
  assert.notEqual(j.pushed, true);
  assert.equal(f.remoteHead(), head);
  assert.match(f.git('status', '--porcelain'), /file.txt/);
});

test('timeout push rejection keeps commits and timeout reason with publication diagnostics', async t => {
  const f = remoteFixture(t);
  let local;
  f.m.spawnClaude = async () => {
    local = f.localCommit('done.txt', 'completed');
    f.remoteCommit('concurrent.txt', 'remote advanced during agent work');
    return {timedOut: true};
  };
  const j = await execute(f);
  assert.equal(j.error_code, 'job_timeout');
  assert.equal(j.pushed, false);
  assert.match(j.publication_error, /publication_failed/);
  assert.match(j.error, /timed out.*publication_failed/);
  assert.equal(f.git('rev-parse', 'HEAD'), local);
  assert.notEqual(f.remoteHead(), local);
  f.m.spawnClaude = async () => ({code: 0});
  const retry = await execute(f);
  assert.equal(retry.state, 'completed');
  assert.equal(retry.pushed, true);
});

test('project listing exposes cached divergence in both compact and verbose views', async t => {
  const f = remoteFixture(t);
  f.localCommit('local.txt', 'local');
  f.remoteCommit('remote.txt', 'remote');
  f.git('fetch', '-q', 'origin');
  const p = await describeProject(f.m.cfg, 'app', f.repo);
  assert.equal(p.dirty, false);
  assert.equal(p.ahead, 1); assert.equal(p.behind, 1); assert.equal(p.diverged, true);
  const handlers = {};
  registerTools({ registerTool(name, config, fn) { handlers[name] = fn; } }, {
    cfg: f.m.cfg, projects: {list: async () => [p]}, jobs: f.m, log: {info(){}, warn(){}},
  });
  for (const verbose of [false, true]) {
    const result = await handlers.list_projects({verbose});
    assert.equal(result.structuredContent.projects[0].tracking_ref, 'origin/testing/passkeys');
    assert.equal(result.structuredContent.projects[0].ahead, 1);
    assert.equal(result.structuredContent.projects[0].behind, 1);
    assert.equal(result.structuredContent.projects[0].diverged, true);
  }
});

test('project without a remote reports unknown counts, not a false healthy state', async t => {
  const f = fixture(t);
  const p = await describeProject(f.m.cfg, 'app', f.repo);
  assert.equal(p.ahead, null); assert.equal(p.behind, null); assert.equal(p.diverged, null);
});

test('pre-existing Git operation is preserved instead of being aborted by preflight', async t => {
  const f = remoteFixture(t);
  const state = path.join(f.repo, '.git', 'rebase-merge');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'marker'), 'existing operation');
  f.m.spawnClaude = async () => { assert.fail('must not launch'); };
  const j = await execute(f);
  assert.equal(j.error_code, 'checkout_operation_in_progress');
  assert.equal(fs.readFileSync(path.join(state, 'marker'), 'utf8'), 'existing operation');
});

test('real child timeout terminates the agent then publishes its completed commit', async t => {
  const f = remoteFixture(t);
  const bin = path.join(path.dirname(f.repo), 'fake-agent');
  fs.writeFileSync(bin, '#!/bin/sh\nset -e\nprintf completed > done.txt\ngit add done.txt\ngit commit -qm completed\nexec sleep 30\n', {mode: 0o755});
  f.m.cfg.claude.bin = bin;
  f.m.cfg.limits.job_timeout_minutes = 0.02;
  const j = await execute(f);
  assert.equal(j.error_code, 'job_timeout');
  assert.equal(j.pushed, true);
  assert.equal(j.commits, 1);
  assert.equal(f.remoteHead(), f.git('rev-parse', 'HEAD'));
  assert.equal(f.m.procs.size, 0);
});
