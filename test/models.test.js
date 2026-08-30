import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectModel, countFileReferences } from '../src/models.js';
import { DEFAULTS } from '../src/config.js';

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
cfg.models.escalation.complex_agents = ['system-architect'];
const setupYes = { has_claude_setup: true };
const setupNo = { has_claude_setup: false };

test('default tier when nothing triggers', () => {
  const r = selectModel(cfg, { prompt: 'fix the typo in README', mode: 'execute', setup: setupYes });
  assert.equal(r.tier, 'default'); assert.equal(r.model, 'claude-opus-5'); assert.equal(r.max_cost_usd, 5); assert.match(r.reason, /default tier/);
});

test('escalation triggers name their reason', () => {
  assert.match(selectModel(cfg, { prompt: 'x', complexity: 'high', setup: setupYes, mode: 'execute' }).reason, /escalated: caller passed complexity/);
  assert.match(selectModel(cfg, { prompt: 'x', agent: 'system-architect', setup: setupYes, mode: 'execute' }).reason, /high-complexity agent/);
  assert.match(selectModel(cfg, { prompt: 'x'.repeat(3000), setup: setupYes, mode: 'execute' }).reason, /prompt length/);
  assert.match(selectModel(cfg, { prompt: 'touch src/a.ts src/b.ts src/c.ts lib/d.js lib/e.js lib/f.js lib/g.js', setup: setupYes, mode: 'execute' }).reason, /references \d+ files/);
  assert.match(selectModel(cfg, { prompt: 'plan it', mode: 'plan', setup: setupNo }).reason, /no \.claude setup/);
  assert.match(selectModel(cfg, { prompt: 'x', setup: setupYes, mode: 'execute', priorFailure: { id: 'j_1', why: 'hit its cost ceiling' } }).reason, /retry of j_1 which hit its cost ceiling/);
  const r = selectModel(cfg, { prompt: 'x', complexity: 'high', setup: setupYes, mode: 'execute' });
  assert.equal(r.model, 'claude-fable-5'); assert.equal(r.max_cost_usd, 12);
});

test('explicit model always wins, both directions', () => {
  const down = selectModel(cfg, { prompt: 'x', complexity: 'high', explicitModel: 'default', setup: setupYes });
  assert.equal(down.model, 'claude-opus-5'); assert.ok(down.explicit);
  const alias = selectModel(cfg, { prompt: 'x', explicitModel: 'fable', setup: setupYes });
  assert.equal(alias.model, 'claude-fable-5'); assert.equal(alias.tier, 'complex');
  const raw = selectModel(cfg, { prompt: 'x', explicitModel: 'claude-sonnet-5', setup: setupYes });
  assert.equal(raw.model, 'claude-sonnet-5'); assert.equal(raw.tier, 'custom');
});

test('project tier baseline and config-driven names', () => {
  const r = selectModel(cfg, { prompt: 'x', projectOverrides: { tier: 'complex' }, setup: setupYes, mode: 'execute' });
  assert.equal(r.model, 'claude-fable-5'); assert.match(r.reason, /project default tier/);
  const c2 = JSON.parse(JSON.stringify(cfg)); c2.models.tiers.default.model = 'claude-something-else';
  assert.equal(selectModel(c2, { prompt: 'x', setup: setupYes, mode: 'execute' }).model, 'claude-something-else');
  assert.throws(() => selectModel(cfg, { prompt: 'x', projectOverrides: { tier: 'nope' } }), /not configured/);
});

test('countFileReferences is roughly right', () => {
  assert.equal(countFileReferences('edit src/app.ts and lib/util.js, then README.md'), 3);
  assert.equal(countFileReferences('no files here'), 0);
});

test('effort comes from the tier, and an explicit argument overrides it', () => {
  assert.equal(selectModel(cfg, { prompt: 'x', setup: setupYes, mode: 'execute' }).effort, 'medium');
  assert.equal(selectModel(cfg, { prompt: 'x', complexity: 'high', setup: setupYes, mode: 'execute' }).effort, 'high');
  const ex = selectModel(cfg, { prompt: 'x', explicitEffort: 'max', setup: setupYes, mode: 'execute' });
  assert.equal(ex.effort, 'max');
  assert.match(ex.effort_reason, /explicit effort argument/);
  // Explicit effort rides on an explicitly chosen model too.
  assert.equal(selectModel(cfg, { prompt: 'x', explicitModel: 'haiku', explicitEffort: 'xhigh', setup: setupYes }).effort, 'xhigh');
  // A project override beats the tier but not the caller.
  const po = selectModel(cfg, { prompt: 'x', projectOverrides: { effort: 'high' }, setup: setupYes, mode: 'execute' });
  assert.equal(po.effort, 'high');
});

test('complexity low de-escalates to the fast tier and short-circuits escalation', () => {
  const r = selectModel(cfg, { prompt: 'rename foo to bar', complexity: 'low', setup: setupYes, mode: 'execute' });
  assert.equal(r.tier, 'fast');
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.effort, 'low');
  assert.match(r.reason, /de-escalated: caller passed complexity "low"/);
  // A long prompt describing trivial work must not drag it back up.
  const long = selectModel(cfg, { prompt: 'x'.repeat(3000), complexity: 'low', setup: setupYes, mode: 'execute' });
  assert.equal(long.tier, 'fast');
  // An explicit project tier still wins over de-escalation.
  const pinned = selectModel(cfg, { prompt: 'x', complexity: 'low', projectOverrides: { tier: 'complex' }, setup: setupYes, mode: 'execute' });
  assert.equal(pinned.tier, 'complex');
});

test('effort is omitted entirely when nothing configures one', () => {
  const bare = JSON.parse(JSON.stringify(cfg));
  delete bare.models.default_effort;
  for (const t of Object.values(bare.models.tiers)) delete t.effort;
  const r = selectModel(bare, { prompt: 'x', setup: setupYes, mode: 'execute' });
  assert.equal(r.effort, null);
});
