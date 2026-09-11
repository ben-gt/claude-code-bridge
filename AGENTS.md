# Shared Development Guidelines

This file captures common guidance from the Beyond project instruction files. Apply it alongside each project's documentation and more specific directory instructions. Use the project's actual stack, scripts, and conventions rather than assuming a shared framework, database, or authentication provider.

## Understand the Project

- Read the project overview, relevant documentation, and existing code before making changes.
- Identify the established directory structure, data access layer, authentication guards, and UI components.
- Check installed dependency versions and their documentation before using version-sensitive APIs or configuration.
- Use the development, build, lint, and test commands defined by the project.

## Keep Changes Focused

- Follow surrounding code and established architecture. Avoid unrelated refactoring and unnecessary abstractions.
- Check whether existing dependencies or utilities meet the need before adding new ones.
- Match the project's language conventions. In TypeScript, preserve strict typing and avoid `any` unless unavoidable.
- Prefer named exports where consistent with the project, while preserving framework-required exports.

## DRY: Don't Repeat Yourself

- Give each business rule, schema, configuration value, and domain constant one authoritative definition. Reuse existing types, helpers, and components before introducing another implementation.
- Search for existing implementations before adding logic. When fixing a shared rule, update its authoritative implementation and check affected callers for consistency.
- Extract shared behavior when repeated code represents the same concept and should change together. Keep superficially similar code separate when it serves different rules or is likely to evolve independently.
- Prefer small, cohesive helpers with explicit inputs and outputs. Avoid speculative frameworks, excessive parameters, or mode flags introduced solely to combine unrelated cases.
- Derive types, validation, and generated artifacts from an authoritative schema where the project's tooling supports it. Preserve validation at every trust boundary even when validation rules are shared.
- Keep shared modules at the narrowest appropriate scope. Across services or repositories, use explicit contracts or versioned packages when justified; preserve service boundaries and keep server-only code out of browser bundles.
- Link documentation to authoritative definitions instead of maintaining competing copies. Reuse test setup where useful, while keeping expected outcomes independent of the implementation under test.
- Limit deduplication to the task's scope and verify that extraction preserves behavior for affected callers.

## Data and API Boundaries

- Access the database through the project's established helpers or data layer, using its existing driver or ORM.
- Validate incoming data at the server boundary using the project's validation conventions.
- Return appropriate HTTP status codes and consistent, structured error responses.
- Preserve data ownership and access scope in queries. In multi-tenant systems, include tenant constraints.
- Follow existing migration, index, and database setup procedures when changing persistence.

## Authentication and Security

- Protect routes and operations with the established authentication and authorization mechanisms.
- Enforce roles and ownership on the server; UI visibility alone is not access control.
- Preserve distinctions between session expiry, denied access, and authentication service failures where the system supports them.
- Keep secrets in environment configuration. Never commit secret-bearing files or log passwords, tokens, or full API keys.
- Preserve existing audit logging for state changes and sensitive operations.

## UI Consistency and Accessibility

- Reuse the project's component library, design tokens, and theme system.
- Prefer semantic colour tokens over hardcoded colours and preserve light and dark mode support.
- Keep interactive controls keyboard accessible and give form inputs accessible labels.
- Use established notification and confirmation components for user feedback.
- Follow the project's framework conventions for rendering, state, data fetching, and mutations.

## Verification and Handoff

- Run the checks relevant to the change using the project's scripts, and address failures caused by the work.
- For behavioral changes, follow existing test conventions and cover meaningful success, failure, and boundary cases.
- Mock external services in unit tests where appropriate; do not depend on live production services.
- Do not weaken assertions to make failing tests pass.
- Check lint and types separately when the production build does not enforce them.
- Keep affected documentation accurate and summarize the changes, validation performed, and any remaining limitations.

## JPL Power of Ten Alignment

Apply the following adaptation of Gerard J. Holzmann's [Power of Ten](https://spinroot.com/gerard/pdf/P10.pdf), developed at NASA/JPL. These are practical rules for this collection of web projects, not a claim of compliance with JPL flight-software standards. The original rules primarily target C; the adaptations below explicitly accommodate managed runtimes and web frameworks.

1. **Keep control flow simple.** Prefer straightforward branches and early returns. Avoid direct or indirect recursion in application logic; use explicit iteration with a work limit. Document any necessary recursive algorithm and enforce a depth limit.
2. **Bound work.** Give application-controlled loops, retries, pagination, and queue drains explicit limits. Set deadlines for network and database operations and cap concurrent tasks. Long-lived workers and event streams need cancellation, bounded work per cycle, and resource cleanup. Reaching a limit must produce an explicit outcome, not silently truncate required work.
3. **Bound resource use.** JavaScript requires dynamic allocation, so the original allocation ban does not apply literally. Cap payloads, batches, caches, queues, and buffered results; stream large datasets and release connections, timers, and listeners when finished.
4. **Keep functions reviewable.** Aim for no more than roughly 60 lines per function with one clear responsibility. Extract meaningful helpers rather than compressing statements to meet the target. Explain exceptions when splitting would reduce clarity.
5. **Check meaningful invariants.** Add side-effect-free checks for assumptions whose violation could corrupt state or cause an unsafe operation, and define how failure is handled. The original assertion-density target is replaced here by meaningful coverage of preconditions, state transitions, and results; do not add assertions merely to satisfy a count.
6. **Minimize scope and mutation.** Declare variables close to use, prefer `const`, and keep mutable state local. Encapsulate necessary shared state behind explicit interfaces.
7. **Handle inputs and outcomes.** Validate boundary inputs and internal preconditions not guaranteed by types. Handle error results, rejected promises, and partial failures. Await asynchronous work or explicitly supervise it with error handling and lifecycle ownership.
8. **Keep executable behavior visible.** As an adaptation of the preprocessor rule, avoid `eval`, dynamic function construction, and opaque code generation. Keep build-time conditionals limited and test supported configurations. Normal framework tooling remains appropriate.
9. **Limit indirection.** Managed references and framework callbacks are allowed. As an adaptation of the pointer rule, avoid unnecessary mutable aliasing and opaque dynamic dispatch; keep data ownership and callback contracts explicit.
10. **Use automated analysis.** Run the project's compiler or type checker and linter alongside relevant tests. Introduce no new warnings; report existing findings separately. Do not disable checks to obtain a passing result. For new tooling, prefer strict settings and CI enforcement.

Apply these rules to new and modified code without initiating unrelated rewrites. Document necessary deviations, their rationale, and compensating limits or checks in the code or change description.
