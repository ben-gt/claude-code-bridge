// Asking the user a question from inside an unattended run.
//
// A bridge job cannot pause and ask. That is the reason "escalate on a defined
// trigger" has never been implementable here: escalation could only ever mean
// "stop and report", which throws away the run. The channel changes that — it
// is a place both sides can reach, the bridge writes to it via webhook and
// reads it back through the API, so a question can be posted and an answer
// waited for without the chat session being open.
//
// Deliberate constraints:
//   * Only a HUMAN reply counts. The bridge posts to this channel constantly;
//     treating its own traffic as an answer would let a run approve itself.
//   * A timeout is not an approval. It returns `timed_out` and the caller must
//     decide — defaulting to "yes" after silence is how unattended systems do
//     things nobody sanctioned.
//   * The question carries a short token, so an answer can be matched to it
//     when several are outstanding.

const nowNs = () => BigInt(Date.now()) * 1000000n;

const token = () => Math.random().toString(36).slice(2, 6).toUpperCase();

export class Asker {
  constructor(cfg, notify, { log = console } = {}) {
    this.log = log;
    this.notify = notify;
    const n = cfg.notify || {};
    // chat_base_url is the PUBLIC origin, used for links a human clicks. It
    // sits behind Cloudflare Access, so an API GET against it comes back as an
    // HTML login page — which is exactly how the first live test failed: Ben
    // answered "3" and the poller never saw it. Reads go to the same origin
    // the webhook posts to, which is local and not behind Access.
    this.base = String(n.api_base_url || '').replace(/\/+$/, '')
      || (() => { try { return new URL(n.webhook_url).origin; } catch { return ''; } })();
    this.linkBase = String(n.chat_base_url || '').replace(/\/+$/, '');
    this.apiKey = String(n.api_key || '').trim();
    this.channelId = String(n.channel_id || '').trim();
    this.pollMs = Number(n.ask_poll_ms ?? 10000);
    this.enabled = !!(this.base && this.apiKey && this.channelId && notify?.enabled);
    if (!this.enabled && (n.api_key || n.channel_id)) {
      log.warn('ask: partially configured — needs chat_base_url, api_key and channel_id; questions will not be asked');
    }
  }

  /** Messages posted to the channel after `sinceNs`, newest last. */
  async #since(sinceNs) {
    const r = await fetch(`${this.base}/api/v1/channels/${this.channelId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`channel read failed: HTTP ${r.status}`);
    const body = await r.json();
    const msgs = Array.isArray(body) ? body : (body.messages || []);
    return msgs
      .filter(m => BigInt(m.created_at || 0) > sinceNs)
      .filter(m => ((m.user || {}).role || '') !== 'webhook')  // never our own posts
      .sort((a, b) => (BigInt(a.created_at) < BigInt(b.created_at) ? -1 : 1));
  }

  /** Match a reply to one of the offered options: "2", "2." or its text. */
  static choose(text, options) {
    if (!options?.length) return null;
    const t = String(text || '').trim().toLowerCase();
    const n = t.match(/^\s*(\d{1,2})\b/);
    if (n) {
      const i = Number(n[1]) - 1;
      if (i >= 0 && i < options.length) return options[i];
    }
    // Match in BOTH directions. "merge" is a perfectly normal reply to the
    // option "Merge it", and only checking whether the reply contains the
    // option misses every terse answer — which is most of them.
    const norm = o => String(o).trim().toLowerCase();
    const exact = options.find(o => norm(o) === t);
    if (exact) return exact;
    const contains = options.filter(o => t.includes(norm(o)) || (t.length >= 3 && norm(o).includes(t)));
    // Ambiguity is not an answer: if a reply reads as two different options,
    // treat it as free text and let the caller decide rather than guessing.
    return contains.length === 1 ? contains[0] : null;
  }

  /**
   * Post a question and wait for a human reply.
   * @returns {{status:'answered'|'timed_out'|'unavailable', text?:string, choice?:string, token?:string}}
   */
  async ask({ question, options = [], timeout_minutes = 30, context = null }) {
    if (!this.enabled) return { status: 'unavailable' };
    const tok = token();
    const since = nowNs();
    // Kept deliberately tight. The first version spent five paragraphs on
    // framing and instructions before getting to the question, which reads as
    // noise in a feed you are scanning — the question and the options ARE the
    // message.
    const head = `❓ **${tok}**${context ? ` · ${context}` : ''} — ${question}`;
    const body = options.length
      ? options.map((o, i) => `**${i + 1}.** ${o}`).join('  ·  ')
      : '_reply in your own words_';
    this.notify.post(`${head}\n${body}  ·  _${timeout_minutes}m_`);

    const deadline = Date.now() + timeout_minutes * 60000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.pollMs));
      let replies = [];
      try {
        replies = await this.#since(since);
      } catch (e) {
        this.log.warn(`ask ${tok}: could not read the channel (${e.message})`);
        continue;
      }
      if (!replies.length) continue;
      const reply = replies[0];
      const text = String(reply.content || '').trim();
      const choice = Asker.choose(text, options);
      this.log.info(`ask ${tok}: answered (${choice || 'free text'})`);
      this.notify.post(`✅ **${tok}** — ${choice || text.slice(0, 100)}`);
      return { status: 'answered', text, choice: choice || undefined, token: tok };
    }
    this.log.warn(`ask ${tok}: no reply within ${timeout_minutes}m`);
    this.notify.post(`⌛ **Question ${tok}** went unanswered after ${timeout_minutes}m — the job did not proceed`);
    return { status: 'timed_out', token: tok };
  }
}
