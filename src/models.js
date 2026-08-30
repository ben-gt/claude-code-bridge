// Model tier selection. Policy lives in config (models.tiers / models.escalation); this module
// just applies it and explains the choice. Canonical ids were confirmed against Claude Code 2.1.240:
//   --model opus  -> claude-opus-5      --model fable -> claude-fable-5
// Claude Code accepts those aliases too, but config should carry the canonical ids.

const FILE_RE = /(?:^|[\s`'"(,])((?:[\w.@-]+\/)+[\w.@-]+|[\w@-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|md|json|ya?ml|toml|css|scss|html|sql|sh|env|lock|prisma|vue|svelte))(?=$|[\s`'")\],:;])/g;

export function countFileReferences(prompt) {
  const seen = new Set();
  for (const m of String(prompt || '').matchAll(FILE_RE)) seen.add(m[1]);
  return seen.size;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @returns {{ tier: string, model: string, max_cost_usd: number, effort: string|null,
 *             reason: string, effort_reason: string, explicit: boolean }}
 */
export function selectModel(cfg, {
  projectOverrides = {}, prompt = '', mode = 'plan', agent = null, setup = null,
  explicitModel = null, complexity = null, priorFailure = null, explicitEffort = null,
} = {}) {
  const tiers = cfg.models?.tiers || {};
  const defaultTier = cfg.models?.default_tier || 'default';
  const complexTier = cfg.models?.complex_tier || 'complex';
  const esc = cfg.models?.escalation || {};
  const tierFor = name => {
    const t = tiers[name];
    if (!t || !t.model) throw new Error(`model tier "${name}" is not configured (models.tiers in config.json)`);
    return { tier: name, model: t.model, max_cost_usd: t.max_cost_usd ?? cfg.limits?.max_cost_usd ?? 5 };
  };
  // Effort is resolved independently of the tier so an explicit argument can
  // ride on any model: caller > project override > tier > global default.
  // Returning null means "pass no --effort and let Claude Code decide".
  const effortFor = (tierName, why) => {
    if (explicitEffort) return { effort: explicitEffort, effort_reason: 'explicit effort argument' };
    if (projectOverrides.effort) return { effort: projectOverrides.effort, effort_reason: `project effort override` };
    const t = tiers[tierName];
    if (t && t.effort) return { effort: t.effort, effort_reason: `tier "${tierName}" default${why ? ` (${why})` : ''}` };
    const d = cfg.models?.default_effort;
    return d ? { effort: d, effort_reason: 'models.default_effort' } : { effort: null, effort_reason: 'unset (Claude Code default)' };
  };

  // 1. Explicit always wins — tier name, configured model id, alias, or any raw model string.
  if (explicitModel) {
    const m = String(explicitModel).trim();
    if (tiers[m]) return { ...tierFor(m), ...effortFor(m), reason: `explicit model argument (tier "${m}")`, explicit: true };
    const byModel = Object.entries(tiers).find(([, t]) => t.model === m || (t.aliases || []).includes(m));
    if (byModel) return { ...tierFor(byModel[0]), model: byModel[1].model, ...effortFor(byModel[0]), reason: `explicit model argument (${m} = tier "${byModel[0]}")`, explicit: true };
    const base = tierFor(defaultTier);
    return { tier: 'custom', model: m, max_cost_usd: base.max_cost_usd, ...effortFor(defaultTier), reason: `explicit model argument (${m}, not a configured tier; default-tier ceiling applies)`, explicit: true };
  }

  // 2. De-escalation. `complexity: "low"` is the caller telling us this is a
  //    lookup/rename/status-shaped task. It short-circuits the escalation
  //    triggers below on purpose: a long prompt describing a trivial edit
  //    should not drag it back up to the complex tier.
  const fastTier = cfg.models?.fast_tier;
  if (complexity === 'low' && fastTier && tiers[fastTier] && !projectOverrides.tier) {
    return {
      ...tierFor(fastTier), ...effortFor(fastTier),
      reason: `de-escalated: caller passed complexity "low"`, explicit: false,
    };
  }

  // 3. Baseline: project default tier, else global default.
  let chosen = projectOverrides.tier ? tierFor(projectOverrides.tier) : tierFor(defaultTier);
  let reason = projectOverrides.tier ? `project default tier "${projectOverrides.tier}"` : `default tier`;

  // 4. Escalation triggers (crude and explainable; any one is enough).
  const triggers = [];
  if (complexity === 'high') triggers.push('caller passed complexity "high"');
  if (agent && (esc.complex_agents || []).includes(agent)) triggers.push(`high-complexity agent "${agent}"`);
  const len = String(prompt).length;
  if (esc.prompt_length_chars && len > esc.prompt_length_chars) triggers.push(`prompt length ${len} > ${esc.prompt_length_chars} chars`);
  const refs = countFileReferences(prompt);
  if (esc.file_references && refs > esc.file_references) triggers.push(`prompt references ${refs} files (> ${esc.file_references})`);
  if (esc.plan_without_claude_setup !== false && mode === 'plan' && setup && !setup.has_claude_setup) triggers.push('plan mode on a project with no .claude setup');
  if (esc.retry_after_failure !== false && priorFailure) triggers.push(`retry of ${priorFailure.id} which ${priorFailure.why}`);

  if (triggers.length && chosen.tier !== complexTier && tiers[complexTier]) {
    chosen = tierFor(complexTier);
    reason = `escalated: ${triggers.join('; ')}`;
  } else if (triggers.length) {
    reason = `${reason} (already complex tier; triggers: ${triggers.join('; ')})`;
  }
  return { ...chosen, ...effortFor(chosen.tier), reason, explicit: false };
}
