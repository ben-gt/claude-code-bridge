import { z } from 'zod';

export function registerIntegrationTools(server, integrations, { ok, wrap }) {
  const id = { integration_id: z.string().describe('ID returned by plan_integration') };
  server.registerTool('plan_integration', {
    title: 'Plan a guarded testing integration',
    description: 'Pin and rehearse merges from recorded bridge branches into a NEW testing/integration branch in a private repository. Requires per-project integration configuration. Optional default-branch baseline must be enabled in policy. Existing branches are never changed. Returns immediately; poll get_integration_status for pinned commits, diff and conflicts. No repository code is executed and nothing is pushed.',
    inputSchema: { project: z.string(), base_branch: z.string().describe('Exact allowlisted testing branch'),
      sources: z.array(z.string()).min(1).max(8).describe('Source branches in merge order; plain names, e.g. main and bridge/feature-job') },
  }, wrap(async args => ok(integrations.plan(args))));
  server.registerTool('get_integration_status', {
    title: 'Get integration status', description: 'Read a stored integration plan, conflicts, validation diagnostics or published draft PR. Poll while planning, validating, publishing or cancelling.', inputSchema: id,
  }, wrap(async ({ integration_id }) => ok(integrations.get(integration_id))));
  server.registerTool('list_integrations', {
    title: 'List integrations', description: 'Read the latest 100 integration records and their states.', inputSchema: {},
  }, wrap(async () => ok({ integrations: integrations.list() })));
  server.registerTool('execute_integration', {
    title: 'Validate an integration candidate',
    description: 'After the user requests the planned integration, run configured baseline and candidate checks in isolated containers without host credentials, Git metadata or network. Stops on moved refs, policy changes or failures. Returns immediately; poll get_integration_status. Does not push or update existing branches.', inputSchema: id,
  }, wrap(async ({ integration_id }) => ok(integrations.execute(integration_id))));
  server.registerTool('publish_integration', {
    title: 'Publish an integration draft PR',
    description: 'When publication is authorized, publish a fully passing candidate as a NEW testing/integration branch and open a draft PR to its allowlisted testing base. Checks pinned refs again. Never updates an existing branch or merges the PR. Can retry a failed PR creation without duplicating the branch or PR.', inputSchema: id,
  }, wrap(async ({ integration_id }) => ok(integrations.publish(integration_id))));
  server.registerTool('cancel_integration', {
    title: 'Cancel an integration', description: 'Stop integration work and its validation container. Retains the audit record and candidate. A push already accepted by the remote cannot be undone; published branches and PRs are preserved.', inputSchema: id,
  }, wrap(async ({ integration_id }) => ok(integrations.cancel(integration_id))));
}
