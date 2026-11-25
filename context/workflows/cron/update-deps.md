# Dependency updates

The scheduled [Update pnpm workflow](../../../.github/workflows/update-pnpm.yml.genie.ts)
runs weekly on Monday at 06:23 UTC, or manually from the default branch.
It compares the latest stable [pnpm release](https://github.com/pnpm/pnpm/releases)
with `nix/pnpm.nix` and opens a version-specific **draft** PR or adopts an existing
candidate without changing its readiness. It never checks out candidate code,
overwrites its history, or merges.

The native CLI version in `nix/pnpm.nix` must match
`DEFAULT_AGGREGATE_PACKAGE_MANAGER` in
`packages/@overeng/genie/src/runtime/package-json/mod.ts`, the Buck support-tool
protocols, lock-mutator allowlist, active install fixtures, and default tests.
`scripts/update-pnpm.py` measures the wrapper and six native payloads by hashing
raw registry tarball bytes, updates authored sources, then CI runs exactly one
`genie:run` to refresh projections. Never edit generated manifests or contracts.
The existing repository-restricted publisher App token triggers hosted checks;
GitHub signs its API-created normal commits before a new branch is created.
Missing App permissions or an unverified signature fail closed; closed PRs are not duplicated.

Read intervening release notes before bumping. Check store and lockfile
compatibility separately from the CLI version. In particular,
[pnpm#18433](https://github.com/pnpm/pnpm/issues/18433) tracks the cross-process
CAS publication race; a newer release is not evidence that the race is fixed.

Qualification requires signed commits, independent exact-head review, a passing
exact-head `check:quick` receipt, and required hosted checks before readiness.
Payload fetching, regeneration, and checks follow normal host admission.
