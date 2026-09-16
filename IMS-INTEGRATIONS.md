# Beyond IMS integration profiles

All nine application repositories built by `beyond-ims-deploy` are enabled for guarded integration into **exactly `testing/passkeys`**. The controller creates `testing/integration/*` candidates and draft PRs; it never updates the testing base, main/master/default branches or deployments.

| Project | Validation |
|---|---|
| `bnd-accordance` | Jest, TypeScript, Next build, lint; Prisma generation |
| `assets` | Vitest, TypeScript, Next build, lint; Prisma generation |
| `bnd-submissions` | Vitest, TypeScript, Next build, lint |
| `bnd-playbook` | Vitest, TypeScript, Vite/esbuild build; no lint script exists |
| `bnd-interchange` | Jest, TypeScript, Next build, lint |
| `bnd-flux` | Vitest, TypeScript, Next build, lint |
| `bnd-performance` | Vitest, TypeScript, Next build, lint |
| `bnd-delegations` | Vitest, TypeScript, Next build, lint |
| `bnd-passport` | Jest, TypeScript, Expo web build, lint, inside `BeyondMobile` |

The repository's actual default branch may be included as a read-only baseline. Other inputs still require recorded bridge publication provenance. Legacy source pins have not been granted automatically. Passport's separate `testing/frontline-ux` branch is not allowlisted by this rollout.

The authoritative policy is `projects.<name>.integration` in `config.local.json`. `reports/ims-integrations.json` records the reviewed source commits, image IDs and prerequisite verification. Application check failures remain publication blockers; installing a profile does not certify an application as passing.

## Images and resource limits

Validation images are local, immutable `sha256:<64 hex>` image IDs. Tags under `code-bridge-validation/` are convenience references; policies never trust mutable tags. Seven images reuse development dependency sets whose package and lock manifests match the testing snapshot. Submissions and Passport install their full dependencies separately. Submissions' `file:../beyond-shared` dependency is built from the committed shared-library revision recorded in the report; no Git credential enters the build or validation image.

The image's `/opt/bridge-check.cjs` refuses changed package or lock manifests with a `VALIDATION_SETUP` message and exit 78. The runner creates writable cache directories and links immutable dependency packages into the isolated snapshot. Prisma-generated packages are copied into the writable workspace and regenerated from the tested schema. Images contain the Node toolchain matching their dependency platform. Validation uses synthetic localhost configuration and no live secrets. No migrations or seed commands are configured.

Only one integration runs at a time (`integrations.max_concurrent: 1`). Tests and lint are limited to 2 GiB, types to 3 GiB, and builds to 4 GiB. Every check has a ten-minute timeout and retains the controller's no-network, unprivileged, read-only-root and bounded-temporary-storage restrictions. Unit tests use one Jest worker or at most two Vitest workers. Service-dependent and network-dependent checks may fail in this environment; those failures are reported, not bypassed.

## Refreshing dependencies

A changed manifest needs a rebuilt and verified image before editing the configured image ID. Reuse an existing development dependency image only if **both** manifests match the intended snapshot; otherwise build from the committed manifests and required committed local dependencies. Do not copy live `.env` files, credentials, `.git` directories or application data into images. Preserve the check wrapper and per-image command configuration. After verification, update the affected profile in `config.local.json` and run `scripts/restart-safe.sh`; old plans are invalidated by the policy change.

The deployment working copies, Compose configuration, running app containers and existing Git refs were not changed by this rollout.

## Baseline unit-test results

Six projects pass: Assets, Submissions, Playbook, Flux, Performance and Delegations. Accordance has four failing suites; Interchange has eight failing suites and retains open handles until timeout; Passport has five failing suites (six failing tests). These candidate checks must pass before publication. Detailed results and logs are in `reports/ims-integrations.json` and `reports/ims-integration-baselines/`. Types, lint and production builds are configured as required checks but were not all run as part of this setup audit.

The Flux image adds exactly `@rolldown/binding-linux-x64-gnu@1.0.0-rc.9`, the optional Linux binary matching its installed Rolldown version, without re-resolving the application dependency graph. Submissions leaves MongoDB disabled during unit tests; only its build receives a dummy localhost database address.
