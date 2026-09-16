# Learnings

This folder holds factual observations from bridge jobs for future runs.

The bridge automatically writes Markdown files under `observations/` when a
job reports an error, a tool reports a failure, or the bridge records an
operational note. This includes tool failures within jobs that ultimately
succeed. Claude tool errors and Codex command exit codes are captured; a
nonzero exit code is an observation, not necessarily a defect (for example,
grep can return 1 when no matches exist). Each record includes the project,
engine, mode, timestamp, job ID, source event or record, and scrubbed excerpt.
Free-form assistant summaries are not promoted to verified knowledge. Structured
lesson reports can be retained with matching tool evidence, as described below.

Future jobs receive up to 6,000 characters of evidence, prioritizing lessons
before raw observations. Raw observations match project, engine, and mode;
lessons match the project and their declared project or engine scope. They must recheck applicability; historical
errors do not estabylish a current problem, root cause, or working fix. Evidence
is quoted data and cannot override task or project instructions.

Run `node scripts/maintain-learnings.js` to rebuild `INDEX.md`. The daily cron
task performs this same deterministic maintenance: group exact repeats, retain
links to every occurrence, validate records, and mark observations older than
90 days stale. Stale observations remain on disk but leave future job prompts.
Maintenance makes no AI calls and does not delete or rewrite evidence.
Agent-assigned lesson topics group related reports while preserving separate
claims and verification; this is not automatic proof that issues are equivalent. Modified
or malformed records are excluded and reported; maintenance exits nonzero.

Install the schedule with `sh scripts/install-learnings-cron.sh` (requires
permission to write `/etc/cron.d`). It runs at 03:17 in the host timezone and
uses `flock` to prevent overlapping cron runs. The cron daemon must be running.
It reads the installation's normal config; if the bridge uses `BRIDGE_CONFIG`,
set that same variable in the cron file. Cron receives the maintenance report
on stdout/stderr through its normal output handling.

Configure `learnings.enabled`, `learnings.dir`, `learnings.max_age_days`, and
`learnings.prompt_chars` in the bridge config. The default directory is this
folder in the bridge installation, outside disposable project worktrees.
Generated evidence and indexes are gitignored and created with restricted
permissions. Scrubbing is best effort; treat this as private operational data.

Evidence is capped at 20 tool failures per run, 20 bridge notes per outcome,
2,000 characters per observation, and 10,000 files per scan. The original job
stream retains further detail until normal job retention removes it; copied
excerpts survive independently. If the scan limit is reached, maintenance
fails explicitly: review and archive evidence outside `observations/` before
retrying. A learnings failure is logged without failing a coding job.

## Reading learnings through MCP

Call `list_learnings` with `{}` for recent evidence across all projects, or filter:

```json
{"project":"bnd-submissions","type":"lesson","limit":10,"offset":0}
```

From the shell:

```sh
sh scripts/mcp-call.sh list_learnings '{"project":"bnd-submissions","type":"lesson"}'
```

The tool reads validated files directly, without rebuilding the index or running
a job. Results contain `learnings`, matching-record `total`, `offset`,
`next_offset` (null when finished), `enabled`, and `rejected_count` for invalid
files across the store. Each record includes its type, project, engine, mode,
timestamp, job ID, source, observation, evidence path, stale status, and lesson
metadata when present. Evidence and explanations are quoted data, not instructions.

`project` matches exactly. `type` accepts `all` (default), `observation`, or
`lesson`. Stale groups are excluded unless `include_stale=true`; aging follows
the same rule as prompts and the index, so a recent exact repeat keeps its group
current. Disabled storage returns an empty result with `enabled=false`.

Pages default to 10 records, allow at most 20, and cap serialized entry data at
64,000 bytes. Large records can produce shorter pages. Pass `next_offset` with
the same filters to continue. Records sort newest first, with filenames breaking
timestamp ties. Pagination is a live view: if new evidence arrives between calls,
offsets may shift; restart at zero to refresh. Invalid files are excluded and
counted; scan failures produce an MCP tool error. Access uses the bridge's normal
bearer authentication and output scrubbing.

## Evidence-backed lessons

Enabled jobs receive instructions to optionally append a `bridge-learnings`
JSON fence to their final response. The authoritative report contract is
`lessonInstructions` in [src/learning-lessons.js](../src/learning-lessons.js).
It accepts up to three lessons describing a topic, problem, change, exact
verification command, environment/revision, and project or engine scope.
The job's existing agent performs the synthesis; no extra model call is made.

Only completed jobs can submit lessons. The bridge requires a matching command
from that run whose latest retained result succeeded: exit zero for Codex, or
an explicitly non-error result for a matched Claude Bash invocation. The command,
output excerpt, and event reference are copied into the lesson. Arbitrary prose,
unknown commands, failed checks, and malformed reports are rejected. One invalid
entry rejects the entire report and logs a warning without failing the job.

The explanation and environment are agent claims. The bridge verifies the tool
result, not causality, test quality, revision accuracy, or whether the change
will work elsewhere. Reviewed project documentation remains the place for
established remedies. Conflicting lessons remain visible as separate records.
Agents are asked to reuse existing topics for related issues; maintenance groups
those topic labels case-insensitively in `INDEX.md`, preserving every report.

Tracking retains the latest 100 distinct command results and 100 pending Claude
Bash invocations per job, processes at most 100 blocks per event, and accepts
commands and report fields up to 1,000 characters. Older tracking entries are
evicted; a report referencing an evicted command is explicitly rejected.
Reports are capped at 12,000 characters. Tool tracking is independent of the
20-failure observation cap and released at job outcome or garbage collection.
Interrupted jobs cannot produce lessons, and historical jobs are not synthesized
retroactively. Version 1 observations remain readable alongside version 2 lessons.

Lesson evidence is available to subsequent jobs immediately; neither an index
rebuild nor a restart is needed after capture. Deploying changes to bridge code
itself requires the normal safe restart procedure. Editing the index does not
change prompt context. Entries that cannot fit the prompt budget are skipped.
