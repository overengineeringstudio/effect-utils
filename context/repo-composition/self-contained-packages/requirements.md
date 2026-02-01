# Self-Contained Packages Requirements

## Context

Self-contained packages are the default composition model for our repos. Each package must be independently buildable and publishable without relying on implicit workspace state. The goal is to make dependency resolution deterministic, enable per-package tooling, and keep CI/nix workflows reliable.

## Assumptions

- A1 - This builds on [Nix & Devenv Specification](../nix-devenv/requirements.md).
- A2 - Package configuration files are generated via Genie.
- A3 - Per-package lockfiles are authoritative for dependency resolution.

## Requirements

### Must be self-contained

- R1 - Each package must define its own `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`, plus explicit `exports`. The lockfile must fully capture all direct and transitive dependencies needed for the package's workspace scope.
- R2 - Dependency policy is explicit: library packages list shared runtime deps in both `devDependencies` and `peerDependencies` with explicit ranges, optional peers use `peerDependenciesMeta`, consumers use the delta pattern, and each package must explicitly re-declare any patches it depends on (directly or transitively) in its own `package.json`/genie config.
- R3 - Packages must not impose hidden burdens on downstream consumers; any required peers, patches, or build/tooling assumptions must be declared in the package config so dependents can adopt the package without extra undocumented setup.
- R4 - Dependencies must be strictly re-composed: if a package depends on another package, it must re-expose that package's peer deps and re-declare any required patches (direct or transitive).

### Must be deterministic

- R5 - Dependency resolution must be reproducible from the package's lockfile alone.
- R6 - Tooling must use the same workspace scope when generating the pnpm store and running installs.
- R7 - Offline installs must succeed if lockfiles and hashes are in sync.

### Must handle singleton runtimes

- R8 - Singleton runtime dependencies (e.g. React, React DOM, React Reconciler) must resolve to a single instance within a package workspace during local development, and workspace configuration must explicitly enforce this (e.g. hoisting policy) rather than relying on implicit Node resolution.

### Must be consistent across repos

- R9 - Use shared Genie templates for package config generation.
- R10 - Use shared task modules from effect-utils for installs, checks, and builds.

### Must be verifiable

- R11 - Provide a quick check to detect lockfile drift.
- R12 - Provide a hash/update task that restores consistency after dependency changes.
