import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.js';
import { loadConfig } from '../src/config.js';

test('separate MCP request servers share live operations and record handler failures', async () => {
  let resolve;
  const wait = new Promise(r => { resolve = r; });
  const deps = { cfg: loadConfig(), projects: { list: () => wait }, jobs: { list: () => [] }, log: { info() {}, warn() {} } };
  function client() {
    const handlers = new Map();
    registerTools({ registerTool(name, config, handler) { handlers.set(name, handler); } }, deps);
    return handlers;
  }
  const first = client(), second = client();
  const work = first.get('list_projects')({});
  const during = (await second.get('list_jobs')({})).structuredContent.operations;
  assert.equal(during.active_count, 1);
  assert.equal(during.active[0].tool, 'list_projects');
  resolve([]); await work;
  const after = (await second.get('list_jobs')({})).structuredContent.operations;
  assert.equal(after.active_count, 0);
  assert.equal(after.recent[0].state, 'completed');
  deps.projects.list = async () => { throw new Error('unavailable'); };
  const failed = await first.get('list_projects')({});
  assert.equal(failed.isError, true);
  const final = (await second.get('list_jobs')({})).structuredContent.operations;
  assert.equal(final.active_count, 0);
  assert.equal(final.recent[0].state, 'failed');
});
