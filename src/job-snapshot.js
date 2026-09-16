// One synchronous snapshot: counts and visible state cannot come from different polls.
export function jobSnapshot(records, { recentLimit = 50, activeLimit = 250, now = Date.now() } = {}) {
  const all = [...records].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const counts = { total: all.length, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const job of all) counts[job.state] = (counts[job.state] || 0) + 1;
  const active = all.filter(j => j.state === 'running' || j.state === 'queued');
  const visible = new Map([...all.slice(0, recentLimit), ...active.slice(0, activeLimit)].map(j => [j.id, j]));
  return { counts, observed_at: now / 1000, recent_limit: recentLimit,
    active_limited: active.length > activeLimit, displayed_jobs: visible.size,
    jobs: [...visible.values()].map(j => ({
      job_id: j.id, kind: j.kind || 'claude', state: j.state, project: j.project,
      mode: j.mode, created_at: j.created_at, model: j.model || j.model_selected,
      elapsed_seconds: j.started_at ? Math.max(0, Math.round(((j.finished_at ? Date.parse(j.finished_at) : now) - Date.parse(j.started_at)) / 1000)) : 0,
      activity: j.activity, summary: j.summary, branch: j.branch, pr_url: j.pr_url,
      error: j.error, cost_usd: j.cost_usd,
    })) };
}
