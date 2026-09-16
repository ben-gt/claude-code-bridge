// Process-wide direct-call activity, shared by the per-request MCP servers.
// Status readers observe existing work; counting them would double-count jobs
// and make the dashboard's own refreshes look like new work.
import { randomUUID } from 'node:crypto';
const OBSERVERS = new Set(['get_activity_snapshot', 'list_jobs', 'get_task_status', 'get_task_log', 'get_goal_status', 'get_integration_status']);

export class OperationTracker {
  constructor({ now = Date.now, activeLimit = 250, recentLimit = 50 } = {}) {
    this.now = now;
    this.activeLimit = activeLimit;
    this.recentLimit = recentLimit;
    this.active = new Map();
    this.recent = [];
    this.activeCount = 0;
  }

  async run(name, args, handler) {
    if (OBSERVERS.has(name)) return handler();
    const started = this.now();
    const record = { operation_id: randomUUID(), tool: name, state: 'running',
      project: typeof args?.project === 'string' ? args.project.slice(0, 200) : undefined,
      started_at: new Date(started).toISOString(), started_ms: started };
    this.activeCount++;
    if (this.active.size < this.activeLimit) this.active.set(record.operation_id, record);
    try {
      const result = await handler();
      record.state = result?.isError ? 'failed' : 'completed';
      return result;
    } catch (error) {
      record.state = 'failed';
      throw error;
    } finally {
      this.activeCount--;
      this.active.delete(record.operation_id);
      record.finished_at = new Date(this.now()).toISOString();
      record.elapsed_seconds = Math.max(0, (this.now() - started) / 1000);
      // Keep only safe metadata: never prompts, tool arguments, output or errors.
      delete record.started_ms;
      this.recent.unshift(record);
      this.recent.length = Math.min(this.recent.length, this.recentLimit);
    }
  }

  snapshot() {
    return { active_count: this.activeCount, active_limited: this.activeCount > this.active.size,
      active: [...this.active.values()].map(({ started_ms, ...record }) => ({ ...record,
        elapsed_seconds: Math.max(0, (this.now() - started_ms) / 1000) })),
      recent: this.recent.map(record => ({ ...record })) };
  }
}

export const operations = new OperationTracker();
