// Deployment profile: run the bridge against a deployment that keeps its own line of work.
//
// Without a `deployment` block in the config nothing here is used and the bridge behaves as before
// (one shared `execution_branch`, pushed to origin under the same name, the checkout in the workspace root).
//
// With one, a project's jobs do not work in the workspace checkout at all. They get the bridge's own
// git worktree of that repository (<workspace_root>/<worktree_dir>/<project>, on `work_branch`), which is
// brought up to the project's LINE before every job. The line is the code that is live on this deployment:
// the HEAD of the worktree named in `projects.<name>.line.worktree` (where other people and agents work),
// or, for a project without one, the pushed `push_branch`, or `base_ref` when nothing was pushed yet.
// When a job finishes, its commits are merged into the line fast-forward (rebased first if the line moved,
// refused if they conflict or would overwrite uncommitted edits there) and pushed to `push_branch` only.
import fs from 'node:fs';
import path from 'node:path';
import { git, run, GitError, currentBranchFast, workingTreeStatus, branchExists, isGitRepo } from './git.js';
import { projectOverrides } from './config.js';
import { realWorkspaceRoot } from './paths.js';

const short = sha => String(sha || '').slice(0, 10);
const bare = ref => String(ref || '').replace(/^\+/, '').replace(/^refs\/heads\//, '');

/** The active profile, or null. A profile without a push branch is not a profile. */
export function deploymentOf(cfg) {
  const d = cfg?.deployment;
  return d && typeof d === 'object' && d.push_branch ? d : null;
}

export function workBranch(cfg) { return deploymentOf(cfg)?.work_branch || 'bridge/line'; }

/** Where the bridge's own worktree of a project lives. A dot directory, so discovery never lists it as a project. */
export function workingCopyPath(cfg, project) {
  const d = deploymentOf(cfg);
  return path.join(realWorkspaceRoot(cfg), d.worktree_dir || '.bridge-lines', project);
}

export function forbiddenPushBranches(cfg) {
  return (deploymentOf(cfg)?.forbidden_push_branches || ['main', 'master']).map(bare);
}

/** What a caller (and the agent) is told about where work goes on this deployment. */
export function deploymentSummary(cfg) {
  const d = deploymentOf(cfg);
  if (!d) return undefined;
  return {
    name: d.name || 'deployment', site: d.site || undefined, pushes_to: d.push_branch, never_pushes_to: forbiddenPushBranches(cfg),
    working_branch: workBranch(cfg),
    note: `Jobs start from the code that is live on this deployment (each project's line), commit in the bridge's own working copy, are merged into the line fast-forward and pushed to ${d.push_branch} only.`,
  };
}

/** Refuse a configuration that could push to a forbidden branch or run a forbidden deploy command. Throws. */
export function validateDeployment(cfg) {
  const d = deploymentOf(cfg);
  if (!d) return;
  if (forbiddenPushBranches(cfg).includes(bare(d.push_branch))) throw new Error(`deployment.push_branch ${d.push_branch} is one of deployment.forbidden_push_branches`);
  if (forbiddenPushBranches(cfg).includes(bare(workBranch(cfg)))) throw new Error(`deployment.work_branch ${workBranch(cfg)} is one of deployment.forbidden_push_branches`);
  for (const [name, ov] of Object.entries(cfg.projects || {})) {
    if (ov?.deploy?.command) {
      try { assertDeployAllowed(cfg, ov.deploy.command); } catch (e) { throw new Error(`projects.${name}.deploy.command: ${e.message}`); }
    }
  }
}

/**
 * The only push this deployment allows is a plain (never forced) update of push_branch.
 * `args` are the arguments of a git command that contains "push". Throws GitError otherwise.
 */
export function assertPushAllowed(cfg, args) {
  const d = deploymentOf(cfg);
  if (!d) return;
  const refuse = why => { throw new GitError(`refused: on this deployment (${d.name || 'profile'}) the bridge pushes only to ${d.push_branch}; ${why}`, { code: 'push_refused' }); };
  const rest = args.slice(args.indexOf('push') + 1);
  const options = rest.filter(a => a.startsWith('-'));
  const positional = rest.filter(a => !a.startsWith('-'));
  const allowedOptions = new Set(['--quiet', '-q', '-u', '--set-upstream', '--porcelain', '--verbose', '-v', '--no-progress']);
  for (const o of options) if (!allowedOptions.has(o)) refuse(`option ${o} is not allowed`);
  const refspecs = positional.slice(1);
  if (!refspecs.length) refuse('a push must name its destination branch');
  for (const spec of refspecs) {
    if (spec.startsWith('+')) refuse(`a forced update (${spec}) is not allowed`);
    const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    if (!spec.includes(':') || !spec.slice(0, spec.indexOf(':'))) refuse(`deleting or implicit refspec "${spec}" is not allowed`);
    if (forbiddenPushBranches(cfg).includes(bare(dst))) refuse(`${bare(dst)} must never be written from here`);
    if (dst.startsWith('refs/') && !dst.startsWith('refs/heads/')) refuse(`"${dst}" is not a branch`);
    if (bare(dst) !== bare(d.push_branch)) refuse(`"${bare(dst)}" is not that branch`);
  }
}

/** Refuse a deploy command that belongs to another deployment (e.g. the original demo's script). Throws. */
export function assertDeployAllowed(cfg, command) {
  const d = deploymentOf(cfg);
  if (!d) return;
  const text = Array.isArray(command) ? command.map(String).join(' ') : String(command);
  for (const bad of d.forbidden_commands || []) {
    if (text.includes(bad)) throw new Error(`refused: ${bad} must not be run on this deployment (${d.name || 'profile'})`);
  }
}

/**
 * Git configuration for the agent's own shell, passed through the environment: any `git push` to a known host
 * goes nowhere. The agent is told not to push; this makes a slip harmless. The bridge's own push does not
 * use this environment and goes through assertPushAllowed instead.
 */
export function jobGitEnv(cfg) {
  const d = deploymentOf(cfg);
  if (!d) return {};
  const prefixes = d.job_push_block || (cfg.clone?.hosts || []).flatMap(h => [`https://${h.host}/`, `git@${h.host}:`, `ssh://git@${h.host}/`]);
  const env = { GIT_CONFIG_COUNT: String(prefixes.length) };
  prefixes.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.bridge-job-push-disabled://${p.replace(/^[a-z]+:\/\//, '')}.pushInsteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = p;
  });
  return env;
}

async function isAncestor(dir, a, b) {
  return (await run('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir })).code === 0;
}
async function head(dir) { return (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim(); }
async function commonDir(dir) {
  return fs.realpathSync(path.resolve(dir, (await git(['rev-parse', '--git-common-dir'], { cwd: dir })).trim()));
}
async function resolveRef(dir, ref) {
  const r = await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Fetch one branch from origin. exists: true (with sha), false (origin has no such branch), null (could not ask). */
export async function fetchBranch(repo, branch) {
  const r = await run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repo, timeoutMs: 120_000 });
  if (r.code === 0) return { exists: true, sha: await resolveRef(repo, `refs/remotes/origin/${branch}`) };
  if (/could ?n[o']t find remote ref/i.test(r.stderr)) return { exists: false };
  return { exists: null, error: r.stderr.trim().split('\n').slice(-1)[0] };
}

/**
 * The head of a project's line right now. Throws `line_disabled` when the project is switched off for this
 * deployment and `line_stale` when the configured line is no longer what the configuration says it is.
 */
export async function lineHead(cfg, project, repo) {
  const d = deploymentOf(cfg);
  const line = projectOverrides(cfg, project).line || {};
  if (line.disabled) throw new GitError(`${project} is not available for bridge jobs on this deployment (${d.name || 'profile'}): ${line.disabled}`, { code: 'line_disabled' });
  const stale = why => new GitError(`the line configured for ${project} (projects.${project}.line) no longer matches this server: ${why}. Nothing was changed. Correct the line in config.local.json (and restart the bridge when no job runs).`, { code: 'line_stale' });
  if (line.worktree) {
    const wt = line.worktree;
    if (!fs.existsSync(wt) || !isGitRepo(wt)) throw stale(`${wt} does not exist or is not a git worktree`);
    if (await commonDir(wt) !== await commonDir(repo)) throw stale(`${wt} is not a worktree of ${repo}`);
    const branch = currentBranchFast(wt);
    if (line.branch && branch !== line.branch) throw stale(`${wt} is on ${branch || 'a detached HEAD'}, not on ${line.branch}`);
    return { sha: await head(wt), worktree: wt, branch, label: `${wt} (${branch || 'detached HEAD'})` };
  }
  const candidates = [line.ref, `refs/remotes/origin/${d.push_branch}`, d.base_ref].filter(Boolean);
  for (const ref of candidates) {
    const sha = await resolveRef(repo, ref);
    if (sha) return { sha, worktree: null, branch: null, ref, label: ref.replace(/^refs\/remotes\//, '') };
  }
  throw new GitError(`${project} has no line on this deployment: none of ${candidates.join(', ') || '(nothing configured)'} exists in ${repo}`, { code: 'line_stale' });
}

/** Share the repository checkout's installed packages with the bridge's worktree, so jobs can type-check and test. */
async function linkNodeModules(repo, work) {
  const src = path.join(repo, 'node_modules');
  const dst = path.join(work, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  fs.symlinkSync(src, dst);
  // A symlink is a file to git, so a "node_modules/" ignore rule does not cover it.
  const exclude = path.join(await commonDir(repo), 'info', 'exclude');
  let text = '';
  try { text = fs.readFileSync(exclude, 'utf8'); } catch { /* none yet */ }
  if (!/^\/?node_modules$/m.test(text)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/node_modules\n`);
  }
}

/**
 * Make the bridge's working copy of the job's project ready: create it if this is the first job, and bring it
 * up to the line. Sets job.line and job.start_sha. Throws GitError with a code the caller reports.
 */
export async function prepareWorkingCopy(m, job) {
  const cfg = m.cfg;
  const d = deploymentOf(cfg);
  const repo = job.repo_path;
  const work = job.project_path;
  const wb = workBranch(cfg);
  const execute = job.mode === 'execute';

  job.activity = `checking origin/${d.push_branch}`;
  m.save(job);
  const remote = await fetchBranch(repo, d.push_branch);
  if (remote.exists === null && execute) throw new GitError(`could not reach origin to check ${d.push_branch} (${remote.error}); nothing was started`, { code: 'checkout_fetch_failed' });
  if (d.base_ref && /^origin\//.test(d.base_ref) && !projectOverrides(cfg, job.project).line?.worktree) await fetchBranch(repo, d.base_ref.replace(/^origin\//, ''));
  const line = await lineHead(cfg, job.project, repo);
  if (remote.exists && remote.sha && !(await isAncestor(repo, remote.sha, line.sha))) {
    const why = `origin/${d.push_branch} (${short(remote.sha)}) has commits that ${line.label} (${short(line.sha)}) does not have, so that line is not the newest code for ${job.project}`;
    if (execute) throw new GitError(`the line configured for ${job.project} is behind what was pushed: ${why}. Nothing was changed. Bring those commits into the line (or correct projects.${job.project}.line) and start again.`, { code: 'line_stale' });
    job.notes.push(`careful: ${why}; this plan was made from the line as it is`);
  }

  if (!fs.existsSync(work)) {
    fs.mkdirSync(path.dirname(work), { recursive: true });
    await run('git', ['worktree', 'prune'], { cwd: repo });
    if (await branchExists(repo, wb)) await git(['worktree', 'add', '--quiet', work, wb], { cwd: repo, timeoutMs: 180_000 });
    else await git(['worktree', 'add', '--quiet', '-b', wb, work, line.sha], { cwd: repo, timeoutMs: 180_000 });
    m.appendTranscript(job, `created the bridge's working copy ${work} on ${wb} at ${short(line.sha)}`);
  }
  if (!isGitRepo(work) || currentBranchFast(work) !== wb) {
    throw new GitError(`the bridge's working copy ${work} is on ${currentBranchFast(work) || 'a detached HEAD'}, not on ${wb}; someone changed it. Put it back on ${wb} (or remove the worktree) and start again.`, { code: 'working_copy_unexpected' });
  }
  if (d.link_node_modules !== false) await linkNodeModules(repo, work).catch(e => job.notes.push(`could not share node_modules with the working copy: ${e.message}`));

  const st = await workingTreeStatus(work, { timeoutMs: 60_000 });
  if (st.dirty && !job.allow_dirty) {
    if (!execute) { job.notes.push(`the bridge's working copy has uncommitted files, so it was not brought up to the line before this plan`); job.line = { head: line.sha, label: line.label, worktree: line.worktree, branch: line.branch }; return; }
    throw new GitError(`${job.project}: the bridge's working copy ${work} has uncommitted changes that are not this job's (${st.entries.length}: ${st.entries.slice(0, 8).join(', ').slice(0, 300)}); they were left as they are.`, { code: 'dirty_tree' });
  }
  if (st.dirty) {
    job.notes.push('resumed with unfinished edits in place; working copy not brought up to the line before this run');
  } else {
    const at = await head(work);
    if (at === line.sha) { /* already there */ }
    else if (await isAncestor(work, at, line.sha)) {
      await git(['merge', '--ff-only', '--quiet', line.sha], { cwd: work, timeoutMs: 120_000 });
    } else {
      // The working copy holds commits the line never received: an earlier job's merge into the line was refused.
      const ahead = Number((await git(['rev-list', '--count', `${line.sha}..HEAD`], { cwd: work })).trim());
      const rescue = `rescue/bridge-${job.id}`;
      await git(['branch', '-f', rescue, 'HEAD'], { cwd: work });
      job.rescue_ref = rescue;
      const r = await run('git', ['rebase', line.sha], { cwd: work, timeoutMs: 120_000 });
      if (r.code === 0) {
        job.notes.push(`${ahead} commit(s) of an earlier job that never reached the line were carried forward onto it and go out with this job (as they were: ${rescue})`);
      } else {
        await run('git', ['rebase', '--abort'], { cwd: work });
        await git(['reset', '--hard', '--quiet', line.sha], { cwd: work, timeoutMs: 60_000 });
        job.notes.push(`${ahead} commit(s) of an earlier job that never reached the line no longer apply to it; they were set aside at ${rescue} and this job starts from the line`);
      }
      m.appendTranscript(job, job.notes[job.notes.length - 1]);
    }
    m.appendTranscript(job, `working copy at ${short(await head(work))}; line ${line.label} at ${short(line.sha)}`);
  }
  job.line = { head: line.sha, label: line.label, worktree: line.worktree, branch: line.branch };
  job.start_sha = await head(work);
}

/**
 * Merge the job's commits into the line and push them to push_branch. Returns false when there is nothing to
 * publish. Throws GitError (line_conflict, line_behind_remote, line_merge_refused, publication_failed, ...)
 * with the line and origin untouched unless the message says otherwise.
 */
export async function publishToLine(m, job) {
  const cfg = m.cfg;
  const d = deploymentOf(cfg);
  const work = job.project_path;
  const repo = job.repo_path || work;
  const wb = workBranch(cfg);
  const line = await lineHead(cfg, job.project, repo);
  let at = await head(work);
  const ahead = Number((await git(['rev-list', '--count', `${line.sha}..${at}`], { cwd: work })).trim());
  if (!ahead) return false;
  const kept = `They are kept on ${wb} in ${work}`;

  if (!(await isAncestor(work, line.sha, at))) {
    const rescue = `rescue/bridge-${job.id}`;
    await git(['branch', '-f', rescue, at], { cwd: work });
    job.rescue_ref = rescue;
    const r = await run('git', ['rebase', line.sha], { cwd: work, timeoutMs: 120_000 });
    if (r.code !== 0) {
      const conflicts = (await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: work })).stdout.trim().split('\n').filter(Boolean);
      await run('git', ['rebase', '--abort'], { cwd: work });
      const e = new GitError(`${line.label} moved while the job ran (${short(job.line?.head)} to ${short(line.sha)}) and the job's ${ahead} commit(s) do not apply on top of it${conflicts.length ? ` (conflicts in ${conflicts.slice(0, 8).join(', ')})` : ''}. Nothing was merged into the line, pushed or deployed. The commits are kept at ${rescue}; the next job on ${job.project} starts from the line again.`, { code: 'line_conflict' });
      e.rescue_ref = rescue;
      throw e;
    }
    at = await head(work);
    job.notes.push(`the line moved while the job ran (${short(job.line?.head)} to ${short(line.sha)}); the job's commits were rebased onto it (as they were: ${rescue})`);
    m.appendTranscript(job, job.notes[job.notes.length - 1]);
  }

  const remote = await fetchBranch(repo, d.push_branch);
  if (remote.exists === null) throw new GitError(`could not reach origin to check ${d.push_branch} (${remote.error}). Nothing was merged into the line or pushed. ${kept}.`, { code: 'publication_failed' });
  if (remote.exists && !(await isAncestor(work, remote.sha, at))) {
    throw new GitError(`origin/${d.push_branch} (${short(remote.sha)}) has commits the line does not have, so the job's commits cannot go there fast-forward. Nothing was merged into the line or pushed. ${kept}. Bring origin/${d.push_branch} into the line first.`, { code: 'line_behind_remote' });
  }

  if (line.worktree) {
    job.activity = `merging into the line (${path.basename(line.worktree)})`;
    m.save(job);
    const r = await run('git', ['merge', '--ff-only', '--quiet', at], { cwd: line.worktree, timeoutMs: 120_000 });
    if (r.code !== 0) {
      throw new GitError(`could not fast-forward ${line.label} to the job's commits: ${r.stderr.trim().replace(/\s+/g, ' ').slice(0, 500)}. This usually means another session has uncommitted edits there in the same files. Nothing was pushed or deployed. ${kept} and go out with the next job on ${job.project} once the line can take them.`, { code: 'line_merge_refused' });
    }
    m.appendTranscript(job, `fast-forwarded ${line.label} ${short(line.sha)} to ${short(at)}`);
  }

  job.activity = `pushing to ${d.push_branch}`;
  m.save(job);
  const r = await run('git', ['push', '--quiet', 'origin', `${at}:refs/heads/${d.push_branch}`], { cwd: work, timeoutMs: 180_000 });
  if (r.code !== 0) {
    job.pushed = false;
    throw new GitError(`Push to origin ${d.push_branch} failed: ${r.stderr.trim().replace(/\s+/g, ' ').slice(0, 500)}. ${line.worktree ? `The commits are on the line (${line.label}) locally but not on origin` : kept}; not deployed.`, { code: 'publication_failed' });
  }
  job.pushed = true;
  job.push_target = d.push_branch;
  job.published = { sha: at, line: line.label, pushed_to: d.push_branch, line_was: line.sha, commits: ahead };
  m.appendTranscript(job, `pushed ${short(at)} to origin ${d.push_branch}`);
  return true;
}
