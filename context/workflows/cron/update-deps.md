# Dependency updates

Compare the latest stable [pnpm release](https://github.com/pnpm/pnpm/releases)
with `nix/pnpm.nix`, then open or adopt one version-specific candidate.
Automatic weekly candidate creation is tracked separately; until it lands,
follow these manual steps and the normal pull-request merge policy.

The native CLI version in `nix/pnpm.nix` must match
`DEFAULT_AGGREGATE_PACKAGE_MANAGER` in
`packages/@overeng/genie/src/runtime/package-json/mod.ts`, the Buck support-tool
protocols, lock-mutator allowlist, and active install fixtures. Update all
platform tarball hashes with `nix store prefetch-file --json`, then regenerate
committed projections once with `devenv tasks run genie:run`; do not edit
generated manifests or install contracts directly.

Read intervening release notes before bumping. Check store and lockfile
compatibility separately from the CLI version. In particular,
[pnpm#18433](https://github.com/pnpm/pnpm/issues/18433) tracks the cross-process
CAS publication race; a newer release is not evidence that the race is fixed.

Qualification requires signed commits, independent exact-head review, a passing
exact-head `check:quick` receipt, and required hosted checks before readiness.
Payload fetching, regeneration, and checks follow normal host admission.
