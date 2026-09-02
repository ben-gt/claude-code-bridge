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

const oneLine = (s, n = 220) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
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

  jobStarted(job) {
    const bits = [job.model_selected, job.effort_selected && `effort ${job.effort_selected}`, job.mode]
      .filter(Boolean).join(' · ');
    this.post(`${GLYPH.running} **${job.project}** started — ${bits}${job.goal_id ? ` · goal \`${job.goal_id}\`` : ''}\n${oneLine(job.summary, 140)}`);
  }

  jobFinished(job) {
    const g = GLYPH[job.state] || '·';
    const cost = job.cost_usd != null ? `$${Number(job.cost_usd).toFixed(2)}` : null;
    const bits = [cost, elapsed(job), job.goal_id ? `goal \`${job.goal_id}\`` : null].filter(Boolean).join(' · ');
    const lines = [`${g} **${job.project}** ${job.state}${bits ? ` — ${bits}` : ''}`];
    if (job.pr_url) lines.push(job.pr_url);
    else if (job.branch) lines.push(`branch \`${job.branch}\``);
    const tail = job.state === 'completed' ? job.result_text : (job.error || job.result_text);
    if (tail) lines.push(`> ${oneLine(tail)}`);
    this.post(lines.join('\n'));
  }

  goalCreated(goal, count) {
    this.post(`◆ **Goal \`${goal.id}\`** — ${oneLine(goal.objective, 180)}\n${count} job(s) dispatched · budget $${goal.budget_usd.toFixed(2)}`);
  }

  goalFinished(goal, { counts, spent }) {
    const done = [
      counts.completed && `${counts.completed} done`,
      counts.failed && `${counts.failed} failed`,
      counts.cancelled && `${counts.cancelled} cancelled`,
    ].filter(Boolean).join(', ') || 'no children';
    this.post(`◆ **Goal \`${goal.id}\`** ${goal.state} — ${done} · $${spent.toFixed(2)} of $${goal.budget_usd.toFixed(2)}`);
  }
}
