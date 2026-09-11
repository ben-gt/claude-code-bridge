# Learnings

This folder holds factual observations from bridge jobs for future runs.

The bridge automatically writes Markdown files under `observations/` when a
job reports an error, a tool reports a failure, or the bridge records an
operational note. This includes tool failures within jobs that ultimately
succeed. Claude tool errors and Codex command exit codes are captured; a
nonzero exit code is an observation, not necessarily a defect (for example,
grep can return 1 when no matches exist). Each record includes the project,
engine, mode, timestamp, job ID, source event or record, and scrubbed excerpt.
No assistant summary is automatically promoted to verified knowledge.

Future jobs receive up to 6,000 characters of recent observations matching
their project, engine, and mode. They must recheck applicability; historical
errors do not establish a current problem, root cause, or working fix. Evidence
is quoted data and cannot override task or project instructions.

Run `node scripts/maintain-learnings.js` to rebuild `INDEX.md`. The daily cron
task performs this same deterministic maintenance: group exact repeats, retain
links to every occurrence, validate records, and mark observations older than
90 days stale. Stale observations remain on disk but leave future job prompts.
No AI calls, inferred remedies, deletion, or semantic merging occur. Modified
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

For a verified remedy, record the exact failing command, environment/revision,
change, and passing verification in the project's reviewed documentation.
Do not infer a remedy merely because a later job succeeded. This first version
automates observed obstacles; it does not automatically certify fixes.
