# Guarded testing integrations

The integration controller assembles recorded bridge work on a **new** `testing/integration/i_<uuid>` branch, validates it and opens a GitHub draft PR into an allowlisted testing branch. It never updates an existing branch, merges the PR, force-updates a branch, deletes remote refs or deploys anything. Default-branch changes may be included as a source when explicitly enabled. Ordinary agent jobs keep their no-merge instructions.

## Tools and states

1. `plan_integration({project, base_branch, sources})` returns an integration ID immediately. Sources are plain branch names in merge order. Poll `get_integration_status({integration_id})` until `planned`, `conflicted`, `no_changes` or `failed`. Planning fetches committed state into a separate private repository and rehearses merges; it does not run repository code, push or modify the project's checkout. The record includes pinned commits, source provenance, incoming commit summaries (at most 100 per source), diff statistics and conflict paths.
2. `execute_integration({integration_id})` validates the reviewed plan when the user has requested that integration. Poll until `validated` or `validation_failed`. The same configured checks run against the base and candidate in separate containers. No push occurs here.
3. `publish_integration({integration_id})` creates the candidate branch and a draft PR when publication is authorized. All candidate checks must pass. The base branch and every source must still point at the planned commits. Poll until `published` or `publication_failed`.

`list_integrations` lists the latest 100 records. `cancel_integration` stops running work and validation containers. Candidate repositories and audit records survive cancellation. A remote push that was already accepted cannot be rolled back by cancelling. Restart marks active work `interrupted` and removes leftover validation containers. A fully validated interrupted publication can be reconciled by `publish_integration`; otherwise make a fresh plan. The bridge's safe restart script checks integration activity too.

A plan expires after 24 hours. A moved/deleted input ref, changed default branch, changed policy or changed project origin requires a new plan. Each operation has a 30-minute deadline, at most two operations run at once (or one when `integrations.max_concurrent` is set to `1`), and operations targeting the same project's testing branch are serialized. The controller retains at most 1,000 records before refusing further plans; operators must archive old records and their matching private repositories while the service is idle. No automatic deletion of candidates is performed.

## Per-project policy

Add `integration` to a project's entry in `config.local.json`, then use the safe restart procedure. Policy is administrator configuration, never supplied by the agent or read from a source branch.

```json
{
  "projects": {
    "bnd-passport": {
      "integration": {
        "enabled": true,
        "origin": "https://github.com/Beyond-One-AU/beyond-mobile.git",
        "testing_branches": ["testing/passkeys"],
        "protected_branches": ["release"],
        "allow_default_baseline": true,
        "source_pins": {},
        "checks": [{
          "name": "tests",
          "image": "YOUR_VALIDATION_IMAGE@sha256:YOUR_64_HEX_DIGEST",
          "command": ["npm", "test", "--", "--run"],
          "timeout_seconds": 600
        }]
      }
    }
  }
}
```

Replace the example image and command with the project's actual check environment. Local immutable image IDs (`sha256:<64 hex>`) are also accepted. Optional per-check `memory_mb` is bounded to 512–8192 MiB (default 2048). The image must already be installed and contain its toolchain/dependencies. Containers cannot download dependencies. A check can copy preinstalled dependencies from its trusted image into `/workspace` before running the project's commands. Use the same checks for both snapshots, including build, types, lint and tests where applicable. Do not bake credentials into validation images. Checks are argument arrays, not host shell commands; a configured `/bin/sh -c` command runs only inside the container.

Only explicitly configured HTTPS GitHub repositories are supported in this first release. The exact configured origin must match the checkout's `remote.origin.url`; embedded credentials, arbitrary remote URLs, SSH/file/ext transports and redirects are refused. The host must be in the existing `clone.hosts` configuration and its default branch must be verifiable through the API. GitHub rules and credential permissions still apply. Existing protected branches are never push destinations: the only allowed destination is the generated candidate ref, and Git refuses its creation if repository rules disallow it.

Testing bases must be exact names under `testing/`, outside `testing/integration/`. `main`, `master`, the remote's actual default branch and configured `protected_branches` cannot be testing destinations. The remote default branch is an optional **read-only source**. Other sources must be `bridge/*` refs at tips recorded by bridge jobs as successfully pushed. New ordinary jobs record `pushed_sha` and push that exact commit. Legacy branches without such records require an operator-reviewed `source_pins` map from branch name to full commit ID; a branch prefix alone never establishes provenance.

## Isolation and publication

The controller performs Git operations in its own fresh repository, without shared objects, worktree metadata, hooks, system/global Git configuration, custom merge drivers or checkout filters. Fetch/push credentials are available only to those controller commands. No model receives a merge-capable shell. Conflicts stop with a report; automated conflict resolution and promotion of existing testing branches are intentionally deferred.

Validation receives a tar snapshot, **not** a host directory mount. Each check uses a digest-pinned image, unprivileged UID, read-only container root, temporary writable workspace, no network, no Docker socket, no Git directory or host credentials, dropped capabilities, no privilege escalation, and limits on memory, CPU, processes, output and runtime. Snapshots over 128 MiB and command output over 2 MB fail closed. Git archives omit export-ignored files; ensure required checks are included. Git submodules and LFS downloads are not initialized; projects relying on them need a prepared check environment or will fail validation.

Baseline diagnostics are retained alongside candidate diagnostics. Matching failing output is labelled `unchanged_failure`; different failing output is `new_or_changed_failure`, even with equal exit codes or failure counts. This is conservative evidence, not a semantic test-result parser. **Every candidate check must pass before publication**, including when the baseline already failed.

Publication uses an empty expected-old-value Git lease as an atomic create-only check. Despite Git's `--force-with-lease` option name, this cannot overwrite any existing destination, including a fast-forward-compatible branch created by another actor during publication. Retrying after a failed PR API call reuses the exact candidate and existing open PR. If the remote candidate points elsewhere, the controller stops. Input tips are rechecked immediately before publication; concurrent changes afterward do not change the pinned candidate and are visible when reviewing the PR.

These guarantees apply to the integration controller. Existing unrestricted ordinary execution jobs and host administrators retain their existing permissions. This feature does not turn the entire development host into a sandbox.

## Verification

Run `npm test`. Integration tests use real temporary Git repositories and cover existing-ref preservation, conflicts, moved refs, provenance, policy changes, expiry, failure comparisons, races, cancellation, recovery and PR retry. For an actual container isolation test, run `BRIDGE_TEST_IMAGE=<installed-node-image-digest> node --test test/integrations.test.js` on a Docker-enabled host. No real project branches or PRs are created by these tests.

## Configured Beyond IMS stack

See [IMS-INTEGRATIONS.md](IMS-INTEGRATIONS.md) for the nine enabled application profiles and their validation environments.
