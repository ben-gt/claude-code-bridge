# Claude Code Bridge

## Demo deployment (`testing/passkeys`)

The demo uses `execution_branch: "testing/passkeys"` and isolated checkouts under `/srv/code-bridge-workspace`. Execute jobs fetch and rebase that branch onto origin, preserving merge structure. Before rebasing divergent history, the bridge pins the original HEAD at `rescue/bridge-<job_id>`. A conflict aborts the rebase back to the original checkout and fails before launching the agent with `error_code: checkout_rebase_conflict`, the project, branch, rescue ref and conflicting files. Fetch failures use `checkout_fetch_failed`; other reconciliation failures use `checkout_sync_failed`. Existing merge/rebase/cherry-pick operations are left untouched and reported as `checkout_operation_in_progress`.

After a timeout or agent failure, the bridge attempts a bounded, non-force push of existing commits. Unfinished staged, unstaged and untracked edits remain local and uncommitted. A rejected push preserves the commits and records `publication_error`; a timeout retains `error_code: job_timeout`. A later clean execution reconciles and publishes stranded commits even if that job makes no new commits. This is best-effort publication after the agent exits: a server crash, explicit cancellation, unavailable remote or unresolved dirty tree still needs inspection. Successful jobs retain the existing leftover-commit behavior. No PR is opened. Existing shared app checkouts are untouched. One job runs at a time. Compose mutation tools are disabled for this mode; demo deployments use the shared build lock and current release configuration. New clones install `pre_push_hook` when configured.

`list_projects` reports `tracking_ref`, `ahead`, `behind` and `diverged` in compact and verbose output. Counts compare HEAD with the **last fetched** origin branch; discovery does not contact remotes. Missing refs or detached/unborn branches report null counts, rather than implying a healthy checkout. `get_task_status` and `list_jobs` expose named job `error_code` values.

`start_task.ticket_context` accepts authorised Flux ticket text and bounded base64 attachments. Files are stored privately outside Git under the job’s `ticket-input` directory with SHA256 hashes. They are read as evidence, never as instructions. Plan mode disables shell and editing tools. Robut exposes this through its per-user, Global Administrator-only `/mcp/code-bridge` endpoint; the bridge bearer token never enters chat.


An MCP server (Streamable HTTP) that exposes **Claude Code in headless mode** to chat surfaces such as Open WebUI, so engineering tasks can be dispatched against any git repository under `~/code` — and new repos pulled down — without opening a terminal.

It is general-purpose infrastructure: it knows nothing about any particular project. It discovers repos, adapts to whatever `.claude` setup a repo has, runs tasks on a **fresh branch**, pushes and opens a **draft PR** when a remote exists, and **never merges anything**.

- Port: **4010** (near the other MCP servers on this box: 3001, 4005). Endpoint: `POST /mcp`. Health: `GET /health`.
- Auth: **Bearer token** — the same scheme as the other MCP connections registered in Open WebUI.
- Process manager: **systemd** (`claude-code-bridge.service`, restart-on-failure), like `code-server.service` on this machine. It needs the host's `~/.claude` login and `~/code`, which is why it runs on the host rather than in compose.
- Workspace root and hard boundary: `~/code` (configurable). Every path is checked *after* realpath resolution.

## Tool surface

| Tool | Purpose |
|---|---|
| `list_projects` | Rescan `~/code` and list every git repo: name, current/default branch, remote (creds stripped), dirty flag, `.claude` setup (CLAUDE.md / preflight / agents), agent names, compose file names. Compact by default (~16 KB for 60 repos); `verbose=true` adds paths, agent descriptions and compose metadata. Optional `filter`. |
| `clone_project` | Clone into `~/code/<name>` using the stored git credentials. Args: `url` **or** `repo` (`owner/repo` + optional `host`), optional `name`, `branch`, `depth`, `full_history`. Shallow by default. Never overwrites — an existing dir returns its path untouched. |
| `list_available_repos` | Repos visible to the stored credentials on each configured host (GitHub, Gitea, GitLab). Marks ones already cloned. Args: `host`, `query`, `limit`. |
| `continue_task` | Resume a job that stopped short (cost ceiling, timeout, restart). Args: `job_id`, optional `prompt`, `max_cost_usd`, `timeout_minutes`. Runs `claude --resume <session>` in the same checkout with a fresh ceiling and time limit, so the context, commits and unfinished edits of the stopped job are kept. Returns a new `job_id`; `get_task_status` on it reports `continues` and `cost_total_usd` for the chain. |
| `start_task` | Dispatch work. Args: `project`, `prompt`, `mode` (`plan` default \| `execute`), optional `agent`, `base_branch`, `max_cost_usd`, `timeout_minutes`, `model`, `complexity`, `retry_of`. Returns a `job_id` immediately (non-blocking; measured ~50 ms) along with the model chosen and why. |
| `start_experiment` | Run a measured optimisation loop (see [Experiments](#experiments)). Args: `project`, `objective`, `measure_command`, `direction` (`minimize` \| `maximize`), `editable[]`, optional `metric_name`, `check_command`, `setup_command`, `max_iterations`, `patience`, `min_improvement`, `measure_runs`, `measure_timeout_seconds`, `target`, `max_cost_usd`, `timeout_minutes`, `model`. Returns a `job_id` immediately. |
| `apply_experiment` | Publish a finished experiment's kept commits. Args: `job_id`. With `execution_branch` set: onto that branch (fast-forward, or cherry-pick when it has moved) and pushed. Otherwise: the experiment branch is pushed and a draft PR opened. |
| `get_task_status` | State, elapsed, current activity, branch, PR URL, model, cost, final result / plan text. **Long-polls while a job is active** (`wait_seconds`, default 20, max 50): one call waits for the next state/activity change instead of the caller spinning. Running jobs get a lean payload (~350 bytes); the full record arrives when the job ends. |
| `get_task_log` | Scrubbed human-readable transcript; `offset` → `next_offset` for incremental polling; `raw=true` for the stream-json events. |
| `cancel_task` | Kill a queued/running job. Default: discard uncommitted agent work, restore the original branch, delete the job branch. `keep_branch=true` commits partial work and keeps the branch. |
| `list_jobs` | Recent jobs (Claude tasks, experiments and compose redeploys) with state, project, model, one-line summary. Filter by `project` / `state`. |
| `compose_status` | `docker compose ps` — services, state, health, ports, uptime. Read-only, works on protected stacks too. |
| `compose_logs` | Tail container logs (`services`, `lines`, `since`). Scrubbed. Read-only. |
| `compose_restart` | `docker compose restart` — no pull, no build. Returns service state before and after. |
| `compose_stop` / `compose_up` | `stop` (containers kept) / `up -d --no-build`. Before/after state in the result. |
| `compose_redeploy` | **Async job**: `pull --ignore-buildable` → `build --pull [--no-cache]` (only if a targeted service has a `build:`) → `up -d --no-build`. Returns a `job_id`; `get_task_status` shows steps + before/after, `get_task_log` streams pull/build output. |

All compose tools take `project`, optional `file`, `services`, `profile`.

Job states: `queued → running → completed | failed | cancelled | interrupted`.

### How a task runs

1. Pre-flight (synchronous, before Claude is invoked): project must resolve inside `~/code`; one active job per project; **dirty working tree is refused** (untracked files count unless `allow_untracked` is set for the project); `agent` must exist in `.claude/agents/`.
2. `plan` mode: `claude -p … --permission-mode plan` with edit tools disallowed. No branch, no commits. The plan is the final message (`result` in status, and `plan.md` in the job dir).
3. `execute` mode: record the current branch → `git fetch origin <default>` (if a remote) → `git checkout -b bridge/<slug>-<id> origin/<default>` (or local default) → run `claude -p … --permission-mode bypassPermissions` with an appended system prompt (stay on branch, commit as you go, don't push/merge/force; run `.claude/preflight.md` if present) → commit any leftovers (`chore(bridge): …`) → if a remote: `git push -u origin <branch>` (never force) and open a **draft PR** through the host API → switch the working tree back to the original branch. No remote: the local branch name is reported. If no commits were produced the empty branch is removed.
   **One session, one answer.** Jobs run with background tasks off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), wake-up/cron/monitor tools denied and `--strict-mcp-config` (no connectors from the login the server runs under). Headless Claude Code emits a `result` event per turn, and a turn can be woken by the session's own background work, so a session may report several results: the job's result (and `plan.md`) is the longest one plus anything said after it, never simply the last. `usage` is the session-wide `modelUsage` total, sub-agents included.

   **Stopped short.** If the ceiling or the timeout lands *after* the agent delivered its result, the job is `completed` with a note. If it lands before, the job is `failed` with `error_code` `cost_ceiling` or `job_timeout`, `result` carries the agent's last message, the error says where the commits are, and `next_step` names the `continue_task` call that finishes it.
4. Bounded by a hard timeout (`job_timeout_minutes`, default 20 — process group killed, partial work committed to the branch) and a cost ceiling (`--max-budget-usd`, default $5 — Claude stops itself and the job is `failed` with the reason).
5. Concurrency: `max_concurrent_jobs` (default 2) global; extra jobs queue. One job per project.

Claude still reads the project's `CLAUDE.md`, `.claude/settings*.json`, agents and skills itself — the bridge doesn't strip any of that; it only layers the unattended-run rules on top via `--append-system-prompt`. Projects with no `.claude` setup run plainly.

## Experiments

`start_experiment` is the bridge's version of [karpathy/autoresearch](https://github.com/karpathy/autoresearch): one metric, one fixed way of measuring it, a narrow place the agent may change, and a loop that keeps only what makes the number better. It fits anything with a number that says "better" and a command that prints it: a benchmark time, a bundle size, the score of an evaluation script over a prompt or a skill file, a count of failing cases. It does not fit a bug fix or a feature; those are `start_task`.

What differs from autoresearch is who is trusted. There the agent runs the training, reads the number and does the `git reset` itself. Here the agent only proposes; everything that decides the outcome is the bridge's:

1. Pre-flight as for any job (project inside the workspace, clean tree, one job per project), plus: every `editable` path must exist, and the whole repository cannot be editable.
2. The bridge reconciles the checkout with origin, then creates a local branch `experiment/<slug>-<id>`. With `setup_command` it runs that once (it may only produce files git ignores).
3. **Baseline.** `check_command` (if given) must pass and `measure_command` must print the metric before any change, or the job fails with `baseline_check_failed` / `baseline_failed` and nothing is left behind.
4. **Each attempt.** One Claude turn (the same session resumed, so it remembers what it tried) makes one change and stops. The bridge then:
   - takes the tree the agent left, whatever it did with git, and compares it with where the turn started;
   - discards the attempt whole if any changed file is outside `editable` (`out_of_scope`), or if the checkout was moved off the experiment branch (`rule_break`; the base branch is put back too);
   - commits the candidate, runs `check_command` (`check_failed` on a non-zero exit), then `measure_command` (`crash` on a non-zero exit, a timeout or no metric line), `measure_runs` times, taking the median;
   - keeps the commit if the metric beat the best so far by more than `min_improvement` (`keep`), otherwise `git reset --hard` to the previous state (`discard`);
   - tells the agent the outcome and the best so far, and asks for the next change.
5. It stops at `max_iterations` (default 6, at most 30), after `patience` attempts in a row without a gain (default 3), when the agent ends a turn with `DONE:`, at `target`, at the cost ceiling or at the time limit (default 90 minutes). A single attempt may use at most 40% of the cost ceiling and 15 minutes; one stopped short is reverted and the loop carries on.
6. The checkout goes back to the branch it was on. Kept commits stay on the experiment branch, **local and unpushed**; a branch that kept nothing is deleted. The job's `result` is the report: baseline, best, a row per attempt, and where the commits are. `results.tsv` in the job directory has the same rows.
7. `apply_experiment` publishes. If the target branch has not moved, that is a fast-forward and the measured state is exactly what is pushed. If it has moved, the commits are cherry-picked and the result says the metric was **not** re-measured on the new base; a conflict aborts and changes nothing.

The metric is read from the measurement's stdout: the last line of the form `metric: 12.4` (or `<metric_name>: 12.4`, `=` also accepted, a unit after the number is ignored), else a bare number on the last non-empty line.

Things the bridge cannot do for you:

- **The measurement has to be out of reach.** `editable` is a whitelist, so a script, fixture or test outside it cannot be touched. If the number is computed from something inside it, an agent can move the number without improving anything.
- **Noise.** A timing that varies 3% run to run will "improve" by chance. Use `measure_runs: 3` and a `min_improvement` above the noise.
- **Ignored files persist between attempts** (`git clean` leaves them, which is what keeps `node_modules` installed). A warm cache can make a later attempt look faster than an earlier one.
- **`check_command` is the only thing protecting behaviour.** Without it, "faster" can mean "does less".

Experiments queue in their own lane (`experiments.max_concurrent`, default 1), so a long one does not hold up ordinary jobs; it does hold its project. Cancelling drops the attempt in progress and keeps what was already kept. A restart mid-experiment marks it `interrupted` and puts the checkout back at the next start.

### Where things live

- Repo: `~/code/claude-code-bridge` (excluded from discovery by config).
- Data: `~/.local/share/claude-code-bridge/jobs/<job_id>/{job.json,transcript.log,stream.jsonl,plan.md,results.tsv}` — flat JSON, survives restarts. The last 500 jobs are kept.
- Token: `~/.config/claude-code-bridge/token` (0600, generated on first start).

## Install / run

```sh
cd ~/code/claude-code-bridge
npm install
npm test                      # unit tests: scrubbing, path guards, clone source parsing
scripts/install.sh            # writes /etc/systemd/system/claude-code-bridge.service, enables + starts it
scripts/restart-safe.sh       # deploy-time restart: waits for running/queued jobs to finish first
systemctl status claude-code-bridge
journalctl -u claude-code-bridge -f
```

Manual run for development: `node src/index.js` (env overrides: `BRIDGE_PORT`, `BRIDGE_HOST`, `BRIDGE_CONFIG`).

Register with the local Open WebUI (uses the same `mcp-connections.sh` helper as the other servers; the host is reached from the `open-webui` container at the compose-network gateway `172.20.0.1`):

```sh
scripts/register-openwebui.sh                      # id=claude_code, private (admin-only) by default
scripts/register-openwebui.sh claude_code http://172.20.0.1:4010/mcp --public
```

### Keeping chat context small

Every tool result a chat model sees stays in that chat's history. A long execute job that was status-polled ~190 times put ~280 KB of near-identical JSON into one chat and eventually overflowed the model's context (empty replies). Mitigations: `get_task_status` long-polls and returns a lean payload while running; `list_projects` is compact by default; `get_task_log` is incremental (`offset`/`next_offset`, 16 KB chunks); and on the Open WebUI side the Beyond pipe compacts tool results older than the last two user turns before each model call, shows a context meter, and asks before compacting the chat at 65% of the window (see `~/code/openui/CONTEXT-COMPACTION.md`).

### How it appears in Open WebUI (this box)

- Connection id `claude_code` → tools are namespaced `claude_code_<tool>` (e.g. `claude_code_start_task`). Registered private (admin-only); `scripts/register-openwebui.sh … --public` to open it up.
- The Beyond pipe (`~/code/openui/plugins/beyond_auto.py`) **gates** the whole `claude_code_` toolkit behind the Toolkit Gate (`toolkit "claude-code"`), like Synceriser and Local IMS Testing: the 14 specs aren't sent to the model until the user agrees ("just for this request or the whole chat?"). The pipe's system prompt also tells the model how to use the environment: start with `list_projects`, `start_task` is plan-mode unless the user clearly wants changes, poll status/log and report the plan or branch + draft PR, relay protected-stack refusals as-is.
- Verified 2026-08-22: Open WebUI handshakes with the bridge (protocol 2025-11-25), the gate hides the tools until granted, and a granted chat turn executed `list_projects` through Open WebUI's own tool loop (bridge journal: `tool list_projects ok`). Every tool call is logged to the journal as `tool <name> ok|error <ms>` — never the arguments.
- If the bridge is down, the tools simply disappear from the chat; the prompt tells the model to say so rather than error.

Call a tool from the shell for debugging:

```sh
scripts/mcp-call.sh list_projects '{"filter":"form"}'
scripts/mcp-call.sh start_task '{"project":"my-app","prompt":"add a health endpoint","mode":"execute"}'
scripts/mcp-call.sh get_task_log '{"job_id":"j_…","offset":0}'
```

### On boot / restart

**Deploying a change: use `scripts/restart-safe.sh`, not a bare `systemctl restart`** — a bare restart kills every running job and marks it `interrupted` (the working tree is left on the job branch for inspection). `restart-safe.sh` waits until nothing is running or queued, then restarts.

The unit has `Restart=always` and `KillMode=control-group`, so Claude child processes die with the server. On every start the bridge loads the job records and marks anything still `queued`/`running` as **`interrupted`** (killing a stray pid if one survived). The project's working tree is left exactly as it was for inspection — which also means the next `start_task` on that project will be refused as dirty until a human sorts it out (or `cancel_task`-style cleanup is done by hand: `git checkout <original-branch>; git branch -D bridge/…`). Leftover temp clone dirs (`~/code/.bridge-tmp`) are removed at start.

## Model selection

Model choice is bridge policy, not something the caller has to decide. Two tiers, both named in `config.json` → `models.tiers` (no code change to swap ids):

| Tier | Model (confirmed on Claude Code 2.1.240) | Ceiling |
|---|---|---|
| `default` | `claude-opus-5` (`--model opus`) | `$5` |
| `complex` | `claude-fable-5` (`--model fable`) | `$12` |

Selection order: **explicit `model` argument always wins** (tier name, configured id/alias, or any raw model string — including choosing the cheaper tier for a heavy task) → project `tier` override → default tier → escalate to the complex tier if *any* trigger fires. Cost ceiling precedence: explicit `max_cost_usd` > project `max_cost_usd` > the tier's ceiling.

Escalation triggers (`models.escalation`; crude on purpose, expected to be tuned):

- caller passes `complexity: "high"`, or `agent` is in `complex_agents`;
- prompt longer than `prompt_length_chars` (2500) or naming more than `file_references` (6) files;
- `plan` mode on a project with no `.claude` setup;
- the most recent attempt with the same prompt on the same project **failed or hit its cost ceiling** (automatic), or `retry_of` names a failed job.

Transparency: `start_task` returns `model`, `tier`, `model_reason`; `get_task_status` reports `model` (what the session actually ran, from Claude's init event), `model_selected`, `tier` and `model_reason` (e.g. `escalated: high-complexity agent "system-architect"`). If the session's model differs from the one requested, a note is added. **An unavailable model fails the job** with `model "<id>" (tier <name>) is not available to this Claude Code login — no fallback attempted`; nothing runs on a different tier silently.

## Docker Compose control

Where a project under `~/code` has a Compose file, the bridge can inspect, restart, stop/start and redeploy it. Detection: every file matching `(docker-)?compose*.ya?ml` in the project root and two levels down is listed in `list_projects` → `compose[]` (`file`, `dir`, `canonical`, `override`).

**Which file runs.** When the project has exactly one canonical file (`compose.yaml` / `docker-compose.yml`, optionally plus its `.override.` companion), the tools run from the project directory and let Compose pick it up. With more than one Compose file and no `file=` argument the call is **refused and the options listed** — the bridge never guesses which one is production. `file` must be one of the detected files and must resolve inside the project; it's passed as `-f` with the working directory set to that file's folder, exactly as if you ran it there.

**Protected stacks.** `compose.protected` (project directory names *or* Compose project names) are refused for `restart`/`stop`/`up`/`redeploy` with a message pointing at a terminal; `status`/`logs` still work. Default list: `openui` (the Open WebUI stack the chat runs in), `form-submissions` and `dms-v3-form-submissions` (the IMS MCP apps), `claude-code-bridge`. If the bridge itself ever runs inside Docker it detects its own container's Compose project at startup and adds it. To add a stack, append its name; to opt out, remove it (both in `config.json`, then `systemctl restart claude-code-bridge`). The compose project name is also checked after `docker compose config` resolves it, so a protected stack can't be reached through a differently-named directory.

**What doesn't exist:** `down`, anything with `-v`/`--volumes`, `rm`, image/system `prune`. Not gated — not implemented (a unit test asserts the verbs are absent). `--remove-orphans` only when `remove_orphans=true` is passed to `compose_redeploy`.

**Mutual exclusion.** One operation per project: a compose op is refused while a Claude Code job (or another compose op) is active on that project, and `start_task` is refused while a compose op runs there. Synchronous ops (`restart`/`stop`/`up`) hold a short in-memory lock; `compose_redeploy` is a job like any other.

**Cancel.** `cancel_task` on a redeploy kills the compose process (SIGTERM, then SIGKILL) and records the step it was in plus the resulting `compose.after` state; containers are left as the interrupted step left them — nothing is rolled back or removed.

**Bounds and honesty.** `compose_redeploy` has a hard timeout (`compose.redeploy_timeout_minutes`, 15). On timeout the step in flight is killed and the job is `failed` with `timed out … during "<step>"` plus `compose.steps` and `before`/`after` service states, never a bare error or a false `completed`. Every mutating result carries `before` and `after`.

**Logs** go through the same scrubber as everything else (env-style `KEY=value` lines, connection strings with credentials, token shapes), capped at 5000 lines / 200 KB per call.

## Config

`config.json` in the repo root; `config.local.json` (gitignored) is merged on top. `config.example.json` documents every key. Summary:

| Key | Meaning |
|---|---|
| `workspace_root` | The boundary. Default `~/code`. |
| `data_dir` | Job records/logs. |
| `server.host/port/token_file` | Bind address, port (4010), token path. |
| `discovery.depth` | 1 = direct children of the root. Raise if you nest by owner. |
| `discovery.exclusions` | Directory names to skip (at any depth). Dot-directories are always skipped. Default includes `node_modules` and this repo. |
| `limits.max_concurrent_jobs` / `job_timeout_minutes` / `max_cost_usd` | Global caps (2 / 20 / $5). |
| `clone.depth` / `timeout_seconds` / `max_size_mb` | Shallow depth (1; 0 = full), clone time cap (600 s), size cap (2048 MB — the partial clone is removed if exceeded). |
| `clone.hosts[]` | `{host, type: github\|gitea\|gitlab, api_base?}` — used for `list_available_repos`, the `owner/repo` shorthand and draft-PR creation. |
| `claude.bin` / `extra_args` / `branch_prefix` / `commit_author` | How Claude is invoked. |
| `models.tiers.<tier>` | `{model, max_cost_usd, aliases[]}` per tier; `models.default_tier` / `complex_tier` name which is which. |
| `models.escalation` | `complex_agents[]`, `prompt_length_chars`, `file_references`, `plan_without_claude_setup`, `retry_after_failure`. |
| `experiments.*` | `max_concurrent` (1), `default_iterations` (6), `max_iterations` (30), `default_patience` (3), `timeout_minutes` (90), `max_timeout_minutes` (480), `attempt_minutes` (15), `attempt_cost_share` (0.4), `measure_timeout_seconds` (300), `setup_timeout_seconds` (900), `max_cost_usd` (null = tier ceiling), `branch_prefix`. |
| `compose.protected[]` | Stacks the bridge refuses to restart/stop/up/redeploy. `redeploy_timeout_minutes`, `restart_timeout_seconds`, `logs_default_lines`. |
| `projects.<name>` | Per-project overrides: `default_branch`, `job_timeout_minutes`, `max_cost_usd`, `allow_untracked`, `tier`. |

Example override (from `config.json`):

```json
"projects": {
  "form-submissions": { "job_timeout_minutes": 30, "max_cost_usd": 8, "tier": "default" }
}
```

## Credentials

- **Git hosts**: the bridge never stores or reads git credentials itself. Clones, fetches and pushes go through git, which uses whatever credential helper / SSH key the machine already has (here: `credential.helper=store` → `~/.git-credentials`, 0600, for github.com and git.gnrl.tech; SSH keys for `git@…` remotes). For API calls (`list_available_repos`, draft PRs) it asks `git credential fill` for the host, keeps the secret in memory only, and registers it with the scrubber so it can never appear in a response or log. Child processes get a minimal environment (`PATH, HOME, USER, LANG, TERM, SHELL, IS_SANDBOX, GIT_TERMINAL_PROMPT`) — no tokens.
- **Rotation** (no redeploy): update the stored credential where git keeps it (`git credential reject` + `git credential approve`, or edit the helper's store), then the next API/clone call picks it up (API credentials are cached for at most 5 minutes). Prefer a fine-grained PAT scoped to the repos you want the bridge to see; GitHub's `/user/repos` only returns what the token can access. (At build time the stored github.com credential was a classic PAT with `repo, workflow, read:user, user:email` — it works, but swapping it for a fine-grained token limited to the repos the bridge should touch is the recommended follow-up; nothing in the bridge needs changing for that.)
- **Claude**: uses the host's Claude Code login (`~/.claude`). `claude auth login` / `claude setup-token` as root to change it.
- **Bridge bearer token**: `scripts/token.sh` prints it; `scripts/rotate-token.sh` generates a new one, restarts the service; then re-run `scripts/register-openwebui.sh` so Open WebUI has the new value.

### Secret scrubbing

Everything written to `transcript.log`, `stream.jsonl`, the server log, and every tool response passes through `src/scrub.js`: URLs with embedded userinfo (`https://user:tok@…`, `mongodb+srv://…`), GitHub/Anthropic/OpenAI/Slack/AWS/Google token shapes, Open WebUI `api_` tokens, JWTs, `Authorization:` headers, private key blocks, env-file lines whose key contains `KEY|SECRET|TOKEN|PASSWORD|…`, JSON `"token": "…"` fields, `--token xxx` flags, plus exact-match values registered at runtime (the server token, credential-helper passwords). It is best-effort pattern matching — the system prompt also tells Claude not to print `.env` contents.

## Clone guardrails

1. Destination is always `~/code/<name>`; `name` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` — no separators, no `..`, no leading dot (`../x`, `/etc/x`, `a/b`, `.hidden` are refused).
2. Existing directory → returned as `status: "exists"`, nothing touched.
3. Only `https://`, `ssh://` and `git@host:path` sources; `file://`, `http://`, `git://`, `ext::` and local paths are refused. Userinfo in https URLs is dropped (auth comes from the helper).
4. Clones go into `~/code/.bridge-tmp/<name>-<rand>` and are renamed into place only on success, so a failed/interrupted clone never leaves a half-populated `<name>`.
5. Time and size caps; partial directories removed on failure.

## Task guardrails

Inside `~/code` only (checked on resolved paths) · branch-only, fresh branch off the default branch, never commits to it, never force-pushes · dirty tree refused before Claude starts · `plan` is the default mode · secrets scrubbed from everything readable · hard timeout + cost ceiling · one job per project, global cap · never merges.

## Claude Code version notes (keep this current)

Built and tested against **Claude Code 2.1.240** (`claude --version`), Node 22.14, `@modelcontextprotocol/sdk` 1.30.0, zod 4, express 5, Docker Compose v2.20.2 (`pull --ignore-buildable`, `ps --format json` as an array; newer versions emit NDJSON — both are parsed). The bridge shells out to the CLI (not the Agent SDK) so it rides the same login and settings the terminal uses. Flags relied on:

- `-p <prompt> --output-format stream-json --verbose` — one JSON event per line: `system/init` (session_id, model, tools), `assistant` (content blocks: text / tool_use; usage), `user` (tool_result), `result` (total_cost_usd, usage, num_turns, duration_ms, is_error, subtype, result).
- `--permission-mode plan` (+ `--disallowedTools Edit Write NotebookEdit EnterWorktree`) for plan jobs; `--permission-mode bypassPermissions` for execute jobs.
- `--max-budget-usd <n>` cost ceiling; `--agent <name>` to run a project agent; `--append-system-prompt <text>`; `--model <id>` from the selected tier (`opus` → `claude-opus-5`, `fable` → `claude-fable-5` confirmed via the `system/init` event's `model` field). An unknown model is *not* rejected up front: the CLI emits `[claude-code:unrecognized_model]` on stderr and a `result` with `is_error` and "There's an issue with the selected model (…)" at $0 — the bridge detects both and fails the job naming the model.
- **Root caveat:** Claude Code refuses `bypassPermissions` when running as root ("cannot be used with root/sudo privileges") unless it believes it's sandboxed; the bridge sets `IS_SANDBOX=1` in the child environment to get past that. If a future version drops that escape hatch, the options are running the service as a non-root user (it needs read/write on `~/code` and its own `~/.claude` login) or `--permission-mode dontAsk` with an `--allowedTools` list.
- `--max-turns` is **not** in this version's `--help`, so it's not used; runtime is bounded by the timeout and budget instead.

If Claude Code changes the stream-json shape, the parser is `JobManager.handleEvent` in `src/jobs.js`; the argument builder is `claudeArgs`/`systemPrompt` right above it.

## Layout

```
src/index.js        HTTP server, bearer auth, stateless Streamable HTTP transport
src/tools.js        MCP tool definitions (all output scrubbed)
src/jobs.js         queue, Claude spawn, stream parsing, branch/push/PR, cancel, restart recovery
src/experiments.js  start_experiment: the measure/keep/revert loop, its report, apply_experiment
src/projects.js     discovery + .claude setup / agent detection
src/clone.js        clone_project, list_available_repos
src/compose.js      compose file detection, target resolution, protected list, compose ops
src/models.js       model tier selection + escalation triggers
src/credentials.js  git credential fill + host API calls (GitHub / Gitea / GitLab)
src/git.js          git helpers with timeouts and a credential-safe env
src/paths.js        workspace boundary + name sanitising
src/scrub.js        secret scrubbing
src/config.js       defaults + config.json / config.local.json
deploy/             systemd unit
scripts/            install.sh, token.sh, rotate-token.sh, register-openwebui.sh, mcp-call.sh
test/               node:test unit tests
```
