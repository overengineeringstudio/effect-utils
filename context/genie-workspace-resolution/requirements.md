# Genie Workspace Resolution Requirements

## Context

We generate `package.json`, `pnpm-workspace.yaml`, and related config via Genie across standalone repos and composed megarepos. Workspace dependency resolution must stay deterministic while supporting multi-repo composition (including cases where the same npm scope exists in multiple roots).

## Assumptions

- A1 - `package.json.genie.ts` per package is the source of truth for package dependencies.
- A2 - Composed catalog and workspace composition stay Genie-driven.
- A3 - `pnpm-workspace.yaml` and `pnpm-lock.yaml` are generated/derived artifacts, not authoritative inputs for resolver decisions.
- A4 - Resolver behavior must work both in single-repo and megarepo contexts.

## Requirements

### Must keep a clear source of truth

- R1 - Dependency declarations must remain package-local in `package.json.genie.ts`; no parallel hand-maintained dependency graph (for example `workspaceDeps`) is allowed.
- R2 - Workspace resolution must be computed from existing canonical inputs (package dependency declarations plus explicit workspace composition config), without introducing a second persistent manifest artifact.
- R3 - Generated outputs (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`) must not be used as authoritative resolver inputs.

### Must be composable across repos

- R4 - Resolver configuration must support multiple workspace roots from multiple repos in one composed workspace.
- R5 - Resolver behavior must not depend on implicit folder conventions; roots and mapping policy must be explicit in configuration.
- R6 - Same-scope multi-root cases (for example `@overeng/*` from more than one repo) must be handled deterministically with explicit policy.

### Must be strict and deterministic

- R7 - Ambiguous package location resolution must fail fast with actionable errors (package name, candidate roots, and resolution guidance).
- R8 - Missing internal package mappings for declared workspace deps must fail fast.
- R9 - Resolver output must be deterministic: stable deduped sorted results for equivalent inputs.

### Must reduce redundancy and boilerplate

- R10 - Consumers must not re-implement custom transitive workspace dependency algorithms.
- R11 - Shared runtime helpers should provide the standard resolver workflow for both single-repo and megarepo consumers.
- R12 - Existing manual patterns should be removed during migration (no legacy dual-path support in final state).

### Must preserve existing capabilities

- R13 - Transitive dependency traversal must include `dependencies`, `devDependencies`, and `peerDependencies` for internal/workspace packages.
- R14 - Resolver behavior must continue supporting cross-repo package inclusion and extra package patterns where explicitly configured.

### Must be verified

- R15 - Unit tests must cover single-repo, multi-scope megarepo, and same-scope multi-root ambiguity scenarios.
- R16 - Integration checks must validate generated `pnpm-workspace.yaml` correctness for representative consumer repos.
- R17 - Migration must include replacing livestore's explicit workspace dependency graph pattern with the shared resolver approach.

### Must remain self-contained at package level

- R18 - Each package must remain independently installable with package-local lockfile ownership; workspace resolution must not require a root-level shared lockfile model.
- R19 - Resolver design must not depend on root-level workspace hoisting or shared root `node_modules` as a source of truth.

## See Also

- [Nix & Devenv Specification](../nix-devenv/requirements.md)
- [Issue #244](https://github.com/overengineeringstudio/effect-utils/issues/244)
