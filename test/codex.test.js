import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs, codexSandbox, codexEnv, applyCodexEvent, estimateCost, classifyCodexFailure, codexMessageText, tomlString } from '../src/codex.js';
import { selectModel, resolveEngine } from '../src/models.js';
import { DEFAULTS } from '../src/config.js';

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
const job = over => ({ id: 'j_test', mode: 'plan', model_selected: 'gpt-5.6-terra', tier: 'default', effort_selected: 'medium', notes: [], limits: { max_cost_usd: 5, timeout_minutes: 30 }, ...over });
const feed = (j, events, opts = {}) => { const lines = []; for (const ev of events) applyCodexEvent(j, ev, { transcript: l => lines.push(l), ...opts }); return lines; };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('plan jobs run in the read-only sandbox and never ask for approval', () => {
  assert.equal(codexSandbox(cfg, 'plan'), 'read-only');
  const a = codexArgs(job({ sandbox: 'read-only' }), cfg, { instructions: 'x', lastMessageFile: '/tmp/m' });
  assert.deepEqual(a.slice(0, 2), ['exec', '--json']);
  assert.equal(after(a, '--sandbox'), 'read-only');
  assert.ok(a.includes('approval_policy="never"'));
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(after(a, '--model'), 'gpt-5.6-terra');
  assert.ok(a.includes('model_reasoning_effort="medium"'));
  assert.equal(after(a, '--output-last-message'), '/tmp/m');
  assert.equal(a.at(-1), '-', 'the prompt is read from stdin');
});

test('execute jobs follow codex.execute_sandbox', () => {
  assert.equal(codexSandbox(cfg, 'execute'), 'danger-full-access');
  const a = codexArgs(job({ mode: 'execute', sandbox: 'danger-full-access' }), cfg);
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!a.includes('--sandbox'));
  const ww = { ...cfg, codex: { ...cfg.codex, execute_sandbox: 'workspace-write' } };
  assert.equal(codexSandbox(ww, 'execute'), 'workspace-write');
  assert.equal(after(codexArgs(job({ mode: 'execute', sandbox: 'workspace-write' }), ww), '--sandbox'), 'workspace-write');
  assert.throws(() => codexSandbox({ codex: { execute_sandbox: 'yolo' } }, 'execute'), /execute_sandbox/);
});

test('instructions survive as one TOML string; the CLAUDE.md fallback is on by default', () => {
  const text = 'line one\nline "two" \\ three';
  const a = codexArgs(job({ sandbox: 'read-only' }), cfg, { instructions: text });
  const di = a.find(x => x.startsWith('developer_instructions='));
  assert.equal(JSON.parse(di.slice('developer_instructions='.length)), text);
  assert.equal(tomlString('a"b\nc'), '"a\\"b\\nc"');
  assert.ok(a.includes('project_doc_fallback_filenames=["CLAUDE.md"]'));
  const off = { ...cfg, codex: { ...cfg.codex, read_claude_md: false } };
  assert.ok(!codexArgs(job({ sandbox: 'read-only' }), off).some(x => x.startsWith('project_doc_fallback')));
});

test('the api key travels as CODEX_API_KEY, and only when configured', () => {
  assert.equal(codexEnv(cfg, { PATH: '/bin' }).CODEX_API_KEY, undefined);
  assert.equal(codexEnv({ codex: { api_key: 'sk-test' } }, { PATH: '/bin' }).CODEX_API_KEY, 'sk-test');
});

// Item shapes as documented for `codex exec --json`; the thread/turn/error lines
// match what codex-cli 0.154.0 printed on this box.
test('a successful run fills in session, activity, result and usage', () => {
  const j = job({ sandbox: 'read-only' });
  const lines = feed(j, [
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking about it' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc "cat a.txt"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bash -lc "cat a.txt"', aggregated_output: 'hello\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'first thought' } },
    { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Final plan: do X.' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } },
  ]);
  assert.equal(j.session_id, 't-1');
  assert.equal(j.model, 'gpt-5.6-terra');
  assert.equal(j.result_text, 'Final plan: do X.');
  assert.ok(j._resultSeen);
  assert.equal(j._resultError, undefined);
  assert.deepEqual(j.usage, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 });
  assert.equal(j.cost_usd, undefined, 'no pricing, no invented cost');
  assert.ok(lines.includes('TOOL shell: bash -lc "cat a.txt"'));
  assert.ok(lines.some(l => /-> exit 0 \(6 chars\): hello/.test(l)));
  assert.ok(lines.includes('TOOL edit: update src/a.js'));
  assert.ok(!lines.some(l => l.includes('thinking about it')), 'reasoning is never quoted');
  assert.match(lines.at(-1), /RESULT tokens in=1000 \(cached 400\) out=200 cost=not reported/);
});

test('pricing turns tokens into an estimate and flags an overrun', () => {
  const pricing = { 'gpt-5.6-terra': { input: 2, cached_input: 0.5, output: 10 } };
  // 600k fresh * $2 + 400k cached * $0.5 + 100k out * $10, per million.
  assert.equal(estimateCost('gpt-5.6-terra', { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 }, pricing), 2.4);
  assert.equal(estimateCost('unpriced', { input_tokens: 5 }, pricing), null);
  const j = job({ limits: { max_cost_usd: 1 } });
  feed(j, [{ type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } }], { pricing });
  assert.equal(j.cost_usd, 2);
  assert.match(j.notes.join(' '), /over the \$1 ceiling/);
});

test('an unauthenticated run fails with the fix, not a stack of 401s', () => {
  // Trimmed from a real codex-cli 0.154.0 run with no login and no key.
  const j = job();
  const lines = feed(j, [
    { type: 'thread.started', thread_id: '01a08e6c-3332-78f2-9afc-4ff3a74c76c6' },
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)' },
    { type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' } },
  ]);
  assert.equal(j.activity, 'reconnecting (2/5)');
  assert.match(j._resultError, /Codex is not authenticated.*codex login.*codex\.api_key/);
  assert.ok(!j._resultSeen);
  assert.ok(lines.some(l => l.startsWith('warning: Falling back')));
});

test('model, auth and quota failures are told apart', () => {
  assert.match(classifyCodexFailure(job(), 'The model `gpt-9` does not exist or you do not have access to it.'), /model "gpt-5.6-terra" \(codex tier default\) is not available/);
  assert.match(classifyCodexFailure(job(), 'Incorrect API key provided: sk-78P0H***DKJN'), /not authenticated/);
  // Passed through verbatim so JobManager.isQuotaError still sees it.
  assert.match(classifyCodexFailure(job(), "You've hit your usage limit. Try again later. (429)"), /^codex reported an error: .*usage limit.*429/);
});

test('a model missing from the catalog is noted, not fatal', () => {
  const j = job({ model_selected: 'gpt-5.1-codex-mini' });
  feed(j, [{ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-5.1-codex-mini` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } }]);
  assert.equal(j._resultError, undefined);
  assert.match(j.notes[0], /no catalog entry for model "gpt-5.1-codex-mini"/);
});

test('salvage takes finished agent messages only', () => {
  assert.equal(codexMessageText({ type: 'item.completed', item: { type: 'agent_message', text: 'found it' } }), 'found it');
  assert.equal(codexMessageText({ type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } }), null);
  assert.equal(codexMessageText({ type: 'item.started', item: { type: 'agent_message', text: 'x' } }), null);
});

test('engine: explicit > Codex model > project override > default', () => {
  assert.equal(resolveEngine(cfg, {}).engine, 'claude');
  assert.equal(resolveEngine(cfg, { engine: 'codex' }).engine, 'codex');
  assert.throws(() => resolveEngine(cfg, { engine: 'gemini' }), /engine must be/);
  assert.equal(resolveEngine(cfg, { explicitModel: 'codex' }).engine, 'codex');
  assert.equal(resolveEngine(cfg, { explicitModel: 'gpt-6-astra' }).engine, 'codex');
  assert.equal(resolveEngine(cfg, { explicitModel: 'gpt-5.2' }).engine, 'codex', 'a raw OpenAI id');
  // Tier names are shared, so a bare tier name never switches engine.
  assert.equal(resolveEngine(cfg, { explicitModel: 'complex' }).engine, 'claude');
  assert.equal(resolveEngine(cfg, { explicitModel: 'opus' }).engine, 'claude');
  assert.equal(resolveEngine(cfg, { engine: 'claude', explicitModel: 'codex' }).engine, 'claude', 'explicit engine wins');
  assert.equal(resolveEngine(cfg, { projectOverrides: { engine: 'codex' } }).engine, 'codex');
  assert.equal(resolveEngine({ ...cfg, default_engine: 'codex' }, {}).engine, 'codex');
  assert.throws(() => resolveEngine(cfg, { projectOverrides: { engine: 'Codex' } }), /projects\.<name>\.engine must be one of/);
  assert.throws(() => resolveEngine({ ...cfg, default_engine: 'openai' }, {}), /default_engine must be one of/);
});

test('codex jobs pick from codex.tiers under the same escalation rules', () => {
  const base = { prompt: 'x', mode: 'execute', setup: { agents_md: 'AGENTS.md' }, engine: 'codex' };
  assert.equal(selectModel(cfg, base).model, 'gpt-5.6-terra');
  assert.equal(selectModel(cfg, { ...base, complexity: 'high' }).model, 'gpt-6-astra');
  assert.equal(selectModel(cfg, { ...base, complexity: 'low' }).model, 'gpt-5.6-luna');
  assert.equal(selectModel(cfg, { ...base, explicitModel: 'codex' }).tier, 'default');
  assert.equal(selectModel(cfg, { ...base, explicitModel: 'complex' }).model, 'gpt-6-astra');
  // A repo with only CLAUDE.md counts as set up: Codex reads it through the fallback.
  assert.equal(selectModel(cfg, { ...base, mode: 'plan', setup: { claude_md: 'CLAUDE.md' } }).tier, 'default');
  assert.match(selectModel(cfg, { ...base, mode: 'plan', setup: {} }).reason, /no AGENTS\.md or CLAUDE\.md/);
  assert.throws(() => selectModel({ ...cfg, codex: { tiers: {} } }, base), /codex\.tiers/);
});
