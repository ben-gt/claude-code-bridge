export const taskBaseDescription = 'Exact branch to start from. Required for execute, including goal children; branch instructions in prompt do not select the worktree base. Use list_projects.current_branch when the user asks for the current branch. Project allowed_base_branches restrictions are enforced.';

function validBranch(branch) {
  return typeof branch === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(branch) &&
    !branch.startsWith('-') && !branch.includes('..') && branch !== 'HEAD' &&
    branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

// Called at submission AND launch: queued jobs cannot bypass a policy change.
export function validateTaskBase({ mode = 'plan', base_branch }, overrides = {}) {
  if (base_branch !== undefined && base_branch !== null && !validBranch(base_branch)) {
    throw new Error('invalid base_branch: pass an exact branch name, not HEAD or a revision expression');
  }
  if (mode !== 'execute') return base_branch || null;
  if (!base_branch) throw new Error('execute requires an explicit base_branch argument. Read list_projects and honor the user\'s requested/current branch; putting it only in prompt does not select a base.');
  const allowed = overrides.allowed_base_branches;
  if (allowed !== undefined) {
    if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 50 || !allowed.every(validBranch)) {
      throw new Error('project allowed_base_branches must contain 1–50 exact branch names');
    }
    if (!allowed.includes(base_branch)) throw new Error(`base_branch ${base_branch} is not allowed for this project; allowed: ${allowed.join(', ')}`);
  }
  return base_branch;
}
