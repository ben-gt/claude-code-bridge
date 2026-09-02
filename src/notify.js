// Live job state, pushed to an Open WebUI channel.
//
// Open WebUI already runs Socket.IO, and a channel message is emitted to every
// connected member the moment it lands — so this is real push, not polling, and
// it needs no changes to Open WebUI itself. The inbound endpoint is
//   POST /api/v1/channels/webhooks/{webhook_id}/{token}   body: {content}
// which authenticates on the token in the path, so the bridge needs no user
// session and no API key.
//
// Two rules this module must never break:
//   1. It cannot fail a job. Notification is bookkeeping; a channel being down,
//      slow, or misconfigured must never propagate into the job lifecycle.
//      Everything here is fire-and-forget behind a timeout, and every error is
//      swallowed after one log line.
//   2. It cannot leak. Job output can contain anything the agent read, so every
//      interpolated string goes through scrub() first.

import { scrub } from './scrub.js';

const GLYPH = {
  running: '▶', completed: '✔', failed: '✕',
  cancelled: '⊘', interrupted: '⊘', queued: '·',
};


// Full ids are 16 characters of base36 and appear on every line; the first
// eight are already unique across every goal this bridge has ever run, and a
// short id is the difference between a scannable feed and a wall of hashes.
const shortId = id => String(id || '').slice(0, 10);

// A goal reads better as what it is FOR than as a base36 id. The objective's
// first clause is almost always the name someone would have given it anyway,
// so the id becomes a suffix for disambiguation rather than the headline.
function goalLabel(goal) {
  const first = String(goal.objective || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;:])\s|\s[\u2014-]\s/)[0]
    .replace(/[.;:,]\s*$/, '')
    .trim();
  return first ? (first.length > 60 ? first.slice(0, 60).trim() + '\u2026' : first) : shortId(goal.id);
}

// "claude-fable-5-1" reads as noise next to a project name; "fable-5-1" does not.
const shortModel = m => String(m || '').replace(/^claude-/, '').replace(/^anthropic\//, '');

const oneLine = (s, n = 220) => {
  // Job output is markdown. Quoted verbatim into a channel, a "### Git State
  // Report" heading renders as giant type and a code fence swallows the rest of
  // the line — one job's summary took over the whole feed. Flatten the markers
  // so a quote stays a quote.
  const t = String(s || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

function elapsed(job) {
  if (!job.started_at) return null;
  const end = job.finished_at ? Date.parse(job.finished_at) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(job.started_at)) / 1000));
  return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

export class Notifier {
  constructor(cfg, { log = console } = {}) {
    this.log = log;
    const n = cfg.notify || {};
    // Base URL of the chat UI, so a channel line can link back to the
    // conversation that started the work. Without it the feed tells you what
    // happened but not where to go and say something about it.
    this.chatBase = String(n.chat_base_url || '').replace(/\/+$/, '');
    this.url = String(n.webhook_url || '').trim();
    this.timeoutMs = Number(n.timeout_ms ?? 5000);
    this.enabled = n.enabled !== false && !!this.url;
    this.failures = 0;
    // Posts are serialised. They are fired from the job lifecycle without being
    // awaited, so without a queue the HTTP calls race and the feed can show a
    // goal completing before its last child reports — which is exactly the kind
    // of thing a live feed must never do. Chaining costs nothing (each post is
    // one small request) and makes channel order match event order.
    this.chain = Promise.resolve();
    if (this.enabled) log.info('notify: channel webhook configured');
    else if (n.enabled !== false) log.info('notify: no webhook_url set — live channel updates disabled');
  }

  /** Fire-and-forget from the caller's side, strictly ordered on the wire.
   *  Never awaited by the job lifecycle, never throws into it. */
  post(content) {
    if (!this.enabled) return;
    const body = JSON.stringify({ content: scrub(String(content)) });
    this.chain = this.chain.then(() => this.#send(body)).catch(() => {});
  }

  async #send(body) {
    try {
      const r = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) this.#failed(`HTTP ${r.status}`);
      else this.failures = 0;
    } catch (e) {
      this.#failed(e.message);
    }
  }

  #failed(why) {
    this.failures++;
    // One line the first few times, then silence — a dead channel should not
    // fill the log with the same message once per job for the rest of the day.
    if (this.failures <= 3) this.log.warn(`notify: channel post failed (${why})`);
    if (this.failures === 3) this.log.warn('notify: further channel failures will be silent until one succeeds');
  }

  /** Deep-link back to the chat that dispatched this work, when we know it. */
  chatLink(chatId, label) {
    if (!this.chatBase || !chatId) return null;
    return `[${label}](${this.chatBase}/c/${chatId})`;
  }

  jobStarted(job) {
    // One scannable line. The prompt is deliberately NOT echoed: it is often a
    // page of instructions, and repeating it turned every start into a wall of
    // text that buried the one fact worth seeing — which project just moved.
    const bits = [
      job.mode,
      shortModel(job.model_selected),
      job.effort_selected,
      job.goal_label ? `goal: ${job.goal_label}` : null,
      this.chatLink(job.chat_id, 'chat'),
    ].filter(Boolean).join(' \u00b7 ');
    this.post(`${GLYPH.running} **${job.project}** started \u2014 ${bits}`);
  }

  jobFinished(job) {
    const g = GLYPH[job.state] || '\u00b7';
    const bits = [
      job.cost_usd != null ? `$${Number(job.cost_usd).toFixed(2)}` : null,
      elapsed(job),
      job.goal_label ? `goal: ${job.goal_label}` : null,
      this.chatLink(job.chat_id, 'chat'),
    ].filter(Boolean).join(' \u00b7 ');
    const lines = [`${g} **${job.project}** ${job.state}${bits ? ` \u2014 ${bits}` : ''}`];
    const link = job.pr_url || (job.branch ? `\`${job.branch}\`` : null);
    if (link) lines.push(link);
    const tail = job.state === 'completed' ? job.result_text : (job.error || job.result_text);
    if (tail) lines.push(`> ${oneLine(tail, 160)}`);
    this.post(lines.join('\n'));
  }

  goalCreated(goal, count) {
    const link = this.chatLink(goal.chat_id, 'chat');
    const bits = [`${count} job(s)`, `budget $${goal.budget_usd.toFixed(2)}`, link].filter(Boolean).join(' \u00b7 ');
    this.post(`\u25c6 **${goalLabel(goal)}** \u2014 ${bits}`);
  }

  goalFinished(goal, { counts, spent }) {
    const done = [
      counts.completed && `${counts.completed} done`,
      counts.failed && `${counts.failed} failed`,
      counts.cancelled && `${counts.cancelled} cancelled`,
    ].filter(Boolean).join(', ') || 'no children';
    const link = this.chatLink(goal.chat_id, 'chat');
    const bits = [done, `$${spent.toFixed(2)} of $${goal.budget_usd.toFixed(2)}`, link].filter(Boolean).join(' \u00b7 ');
    this.post(`\u25c6 **${goalLabel(goal)}** ${goal.state} \u2014 ${bits}`);
  }
}
