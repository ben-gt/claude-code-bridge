// OpenAI Codex CLI as a second engine: argument building, environment, and the
// `codex exec --json` event parser. Kept out of jobs.js so the Claude path is
// untouched and so the parser can be tested against recorded events.
//
// Checked against codex-cli 0.154.0 on this box (2026-09-11):
//   - `codex exec --json` prints one event per line: thread.started {thread_id},
//     turn.started, item.started/updated/completed {item: {id, type, ...}},
//     turn.completed {usage}, turn.failed {error: {message}}, and a top-level
//     `error` {message} for transient reconnects, which are NOT fatal.
//   - It reports tokens, never dollars, and usage arrives once, when the turn
//     ends. There is no --max-budget-usd: a Codex job is bounded by its timeout,
//     and its cost is an estimate from codex.pricing when that is filled in.
//   - OPENAI_API_KEY in the environment is ignored by exec ("auth mode none");
//     CODEX_API_KEY is what it sends. Without either it uses ~/.codex/auth.json
//     (`codex login`).
//   - `-c developer_instructions=<toml>` arrives as a developer message, and
//     `project_doc_fallback_filenames=["CLAUDE.md"]` gets a Claude-only repo's
//     instructions to the model (both checked with `codex debug prompt-input`).
//   - The Linux sandbox works here: read-only denies every write; workspace-write
//     allows writes in the worktree but keeps .git read-only (so no commits) and
//     blocks the network.

import { run } from './git.js';

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// A JSON string literal is also a valid TOML basic string (same escapes), and
// TOML is what `-c key=value` parses. Checked with multi-line text and quotes.
export const tomlString = s => JSON.stringify(String(s));

export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

/** Sandbox a job runs under. Plan jobs are read-only, enforced by the OS rather
 *  than by withholding tools, so "do not write a plan file" cannot be ignored. */
export function codexSandbox(cfg, mode) {
  if (mode === 'plan') return 'read-only';
  const s = cfg.codex?.execute_sandbox || 'danger-full-access';
  if (!SANDBOXES.includes(s)) throw new Error(`codex.execute_sandbox must be one of ${SANDBOXES.join(', ')} (got ${s})`);
  return s;
}

export function codexArgs(job, cfg, { instructions, lastMessageFile } = {}) {
  const c = cfg.codex || {};
  const args = ['exec', '--json', '--color', 'never'];
  if (job.model_selected) args.push('--model', job.model_selected);
  const sandbox = job.sandbox || codexSandbox(cfg, job.mode);
  if (sandbox === 'danger-full-access') {
    // Parity with the Claude path, which runs execute jobs under
    // bypassPermissions: the agent can install dependencies, run tests and
    // commit. The isolation is the disposable worktree, not the sandbox.
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    // Nobody can answer an approval prompt, so never raise one.
    args.push('--sandbox', sandbox, '-c', 'approval_policy="never"');
  }
  if (job.effort_selected) args.push('-c', `model_reasoning_effort=${tomlString(job.effort_selected)}`);
  if (c.read_claude_md !== false) args.push('-c', 'project_doc_fallback_filenames=["CLAUDE.md"]');
  if (instructions) args.push('-c', `developer_instructions=${tomlString(instructions)}`);
  if (lastMessageFile) args.push('--output-last-message', lastMessageFile);
  if (Array.isArray(c.extra_args)) args.push(...c.extra_args);
  // The prompt goes in on stdin: no ARG_MAX ceiling, and a prompt that happens
  // to start with "-" cannot be parsed as a flag.
  args.push('-');
  return args;
}

/** One startup log line: version, how it will authenticate, tiers, sandbox. */
export async function describeCodex(cfg) {
  const bin = cfg.codex?.bin || 'codex';
  const tryRun = async args => { try { return await run(bin, args, { timeoutMs: 10_000 }); } catch (e) { return { code: -1, stdout: '', stderr: e.message }; } };
  const v = await tryRun(['--version']);
  if (!v || v.code !== 0) return `NOT AVAILABLE (${bin} --version failed) — engine "codex" jobs will fail`;
  let auth = 'api key from codex.api_key';
  if (!cfg.codex?.api_key) {
    const s = await tryRun(['login', 'status']);
    const said = `${s.stdout || ''}\n${s.stderr || ''}`.trim().split('\n').filter(Boolean).pop() || 'unknown';
    auth = /not logged in/i.test(said) ? 'NOT LOGGED IN — run `codex login` as root or set codex.api_key' : said;
  }
  const tiers = Object.entries(cfg.codex?.tiers || {}).map(([k, t]) => `${k}=${t.model}`).join(', ');
  return `${String(v.stdout).trim()}; auth: ${auth}; tiers: ${tiers}; execute sandbox: ${codexSandbox(cfg, 'execute')}`;
}

/** Only the key is added; everything else comes from the bridge's minimal env. */
export function codexEnv(cfg, base) {
  const env = { ...base };
  if (cfg.codex?.api_key) env.CODEX_API_KEY = cfg.codex.api_key;
  return env;
}

const AUTH_RE = /\b401\b|unauthori[sz]ed|invalid_api_key|incorrect api key|missing bearer|not logged in/i;
const MODEL_RE = /model_not_found|\bmodel\b.*\b(does not exist|not found|not supported)\b|unsupported model|do not have access to (the )?model/i;

/** Turn a fatal Codex message into the job's error. Quota messages pass through
 *  verbatim so JobManager.isQuotaError still recognises them. */
export function classifyCodexFailure(job, message) {
  const m = String(message || '');
  if (AUTH_RE.test(m)) return `Codex is not authenticated on this box (${trunc(m, 200)}). Run \`codex login\` as root, or set codex.api_key in config.local.json.`;
  if (MODEL_RE.test(m)) return `model "${job.model_selected}" (codex tier ${job.tier}) is not available to this Codex login — no fallback attempted; fix codex.tiers in config.json or pass model=`;
  return `codex reported an error: ${trunc(m, 500)}`;
}

/** USD estimate from token counts. input_tokens includes the cached ones and
 *  output_tokens includes reasoning, as in the Responses API usage block. */
export function estimateCost(model, usage, pricing) {
  const p = pricing?.[model];
  if (!p || !usage) return null;
  const cached = usage.cached_input_tokens || 0;
  const fresh = Math.max(0, (usage.input_tokens || 0) - cached);
  const usd = (fresh * (p.input ?? 0) + cached * (p.cached_input ?? p.input ?? 0) + (usage.output_tokens || 0) * (p.output ?? 0)) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

function pickUsage(u) {
  const out = { input_tokens: u.input_tokens ?? 0, cached_input_tokens: u.cached_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
  if (u.reasoning_output_tokens != null) out.reasoning_output_tokens = u.reasoning_output_tokens;
  return out;
}

/** Visible text of a finished agent message, for salvaging a killed job. */
export function codexMessageText(ev) {
  return ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text ? String(ev.item.text) : null;
}

/** Apply one parsed event to the job record. `transcript` receives the
 *  human-readable lines; nothing here touches disk. */
export function applyCodexEvent(job, ev, { transcript = () => {}, pricing = null } = {}) {
  const t = ev?.type;
  if (t === 'thread.started') {
    job.session_id = ev.thread_id || job.session_id;
    // exec does not echo the model back; what ran is what was asked for.
    job.model = job.model || job.model_selected;
    job.activity = `session started (${job.model || 'model?'})`;
    transcript(`>> codex thread ${job.session_id} started, model=${job.model}, sandbox=${job.sandbox || '?'}`);
  } else if (t === 'turn.started') {
    job.activity = 'working';
  } else if (t === 'item.started' || t === 'item.updated' || t === 'item.completed') {
    itemEvent(job, t, ev.item || {}, transcript);
  } else if (t === 'turn.completed') {
    job._resultSeen = true;
    if (ev.usage) job.usage = pickUsage(ev.usage);
    const u = job.usage || {};
    const est = estimateCost(job.model_selected, job.usage, pricing);
    if (est != null) {
      job.cost_usd = est;
      if (job.limits?.max_cost_usd && est > job.limits.max_cost_usd) {
        job.notes.push(`estimated cost $${est} is over the $${job.limits.max_cost_usd} ceiling — Codex has no in-run budget stop, so the ceiling is advisory for Codex jobs`);
      }
    }
    transcript(`RESULT tokens in=${u.input_tokens ?? '?'} (cached ${u.cached_input_tokens ?? '?'}) out=${u.output_tokens ?? '?'} cost=${est != null ? `~$${est}` : 'not reported by codex'}`);
  } else if (t === 'turn.failed') {
    const msg = ev.error?.message || job._lastError || 'turn failed';
    job._resultError = classifyCodexFailure(job, msg);
    transcript(`!! turn failed: ${trunc(msg, 400)}`);
  } else if (t === 'error') {
    job._lastError = ev.message;
    const m = /Reconnecting\.\.\. (\d+\/\d+)/.exec(ev.message || '');
    if (m) job.activity = `reconnecting (${m[1]})`;
    transcript(`!! ${trunc(ev.message, 300)}`);
  }
}

function itemEvent(job, phase, item, transcript) {
  const started = phase === 'item.started';
  const done = phase === 'item.completed';
  const tool = d => { job.activity = `tool ${trunc(d, 160)}`; transcript(`TOOL ${trunc(d, 300)}`); };
  switch (item.type) {
    case 'agent_message':
      if (done && item.text?.trim()) {
        job.result_text = item.text; // the last one is the final answer
        job.activity = `writing: ${trunc(flat(item.text), 90)}`;
        transcript(`TEXT ${item.text.trim()}`);
      }
      break;
    case 'reasoning':
      // The model's working, not a finding — never quoted into the record.
      job.activity = 'thinking';
      break;
    case 'command_execution':
      if (started) tool(`shell: ${flat(item.command)}`);
      else if (done) {
        const out = String(item.aggregated_output || '');
        const first = out.trim().split('\n')[0] || '';
        const bad = item.status === 'failed' || item.status === 'declined' || (item.exit_code != null && item.exit_code !== 0);
        transcript(`  -> ${bad ? 'ERROR ' : ''}exit ${item.exit_code ?? '?'} (${out.length} chars)${first ? `: ${trunc(first, 160)}` : ''}`);
      }
      break;
    case 'file_change':
      if (done) tool(`edit: ${(item.changes || []).map(c => `${c.kind ? `${c.kind} ` : ''}${c.path}`).join(', ')}${item.status === 'failed' ? ' (failed)' : ''}`);
      break;
    case 'mcp_tool_call':
      if (started) tool(`mcp ${item.server}/${item.tool}`);
      else if (done && (item.status === 'failed' || item.error)) transcript(`  -> ERROR ${trunc(flat(item.error?.message || item.error || 'failed'), 200)}`);
      break;
    case 'web_search':
      if (done) tool(`web_search: ${flat(item.query)}`);
      break;
    case 'todo_list': {
      const items = item.items || [];
      job.activity = `plan: ${items.filter(i => i.completed).length}/${items.length} done`;
      if (started) transcript(`TOOL todo: ${items.length} items`);
      break;
    }
    case 'error':
      // Non-fatal notices; the fatal ones arrive as turn.failed.
      if (/model metadata for .* not found/i.test(item.message || '')) {
        job.notes.push(`codex has no catalog entry for model "${job.model_selected}" and ran it with fallback metadata`);
      }
      transcript(`warning: ${trunc(item.message, 300)}`);
      break;
    default:
      if (done) transcript(`item ${item.type || '?'}`);
  }
}
