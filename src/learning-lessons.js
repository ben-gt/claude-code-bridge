// Agent-authored explanations remain claims; verification comes from tool events.
const MAX_TRACKED = 100;
const MAX_REPORT = 12000;
const MAX_LESSONS = 3;
const runs = new WeakMap();
const fields = ['topic', 'problem', 'change', 'verification', 'environment'];

export function validLessonFields(entry) {
  return Boolean(entry && fields.every(k => typeof entry[k] === 'string' && entry[k].trim() && entry[k].length <= 1000) && ['project', 'engine'].includes(entry.scope));
}

export const lessonInstructions = `After completing useful work and verification, optionally append one fenced code block labelled bridge-learnings containing a JSON array of at most ${MAX_LESSONS} lessons. Each object must contain nonempty strings: topic (a short stable topic; reuse a historical topic for a similar issue), problem, change (what worked), verification (the exact command you ran successfully), environment (revision and relevant environment), and scope (project for reusable knowledge or engine for engine-specific behavior). Each string must be at most 1000 characters. Include only lessons supported by tool results in this run. Do not claim that a passing check proves a root cause or a universal fix. Omit the block when no useful lesson was verified.`;

export function trackVerification(job, event, clean) {
  let run = runs.get(job);
  if (!run) { run = { pending: new Map(), checks: new Map() }; runs.set(job, run); }
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
  };
  const item = event.item;
  if (event.type === 'item.completed' && item?.type === 'command_execution' && typeof item.command === 'string' && item.command.length <= 1000) {
    remember(run.checks, item.command, { passed: item.exit_code === 0, source: `stream.jsonl item ${clean(item.id)}`, output: clean(item.aggregated_output), status: `exit ${item.exit_code}` });
  }
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return;
  // Bound extra processing independently of the engine's own event handler.
  for (const block of blocks.slice(0, MAX_TRACKED)) {
    if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string' && block.input.command.length <= 1000 && typeof block.id === 'string' && block.id.length <= 1000) {
      remember(run.pending, block.id, block.input.command);
    }
    if (event.type === 'user' && block.type === 'tool_result' && run.pending.has(block.tool_use_id)) {
      const command = run.pending.get(block.tool_use_id);
      run.pending.delete(block.tool_use_id);
      remember(run.checks, command, { passed: block.is_error === false, source: `stream.jsonl tool_use_id ${clean(block.tool_use_id)}`, output: clean(typeof block.content === 'string' ? block.content : JSON.stringify(block.content)), status: 'tool reported is_error=false' });
    }
  }
}

export function extractLessons(job, clean, warn) {
  const run = runs.get(job);
  runs.delete(job);
  if (!run || job.state !== 'completed') return [];
  const text = String(job.result_text || '');
  const marker = '```bridge-learnings\n';
  const start = text.indexOf(marker);
  if (start < 0) return [];
  const end = text.indexOf('```', start + marker.length);
  try {
    if (end < 0 || end - start > MAX_REPORT) throw new Error('missing or oversized lesson block');
    const entries = JSON.parse(text.slice(start + marker.length, end));
    if (!Array.isArray(entries) || entries.length > MAX_LESSONS) throw new Error('invalid lesson count');
    return entries.map(entry => {
      if (!validLessonFields(entry)) throw new Error('invalid lesson fields');
      const check = run.checks.get(entry.verification);
      if (!check?.passed) throw new Error('lesson verification has no matching successful tool result');
      return { ...Object.fromEntries(fields.map(k => [k, clean(entry[k]).slice(0, 1000)])), scope: entry.scope, check };
    });
  } catch (error) {
    warn(`learnings: rejected lesson report: ${error.message}`);
    return [];
  }
}
