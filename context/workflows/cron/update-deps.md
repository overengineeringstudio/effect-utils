# Dependency updates

The scheduled [Update pnpm workflow](../../../.github/workflows/update-pnpm.yml.genie.ts)
runs Monday at 06:23 UTC or manually on the default branch. It compares the
latest stable [pnpm release](https://github.com/pnpm/pnpm/releases) with `nix/pnpm.nix`,
then opens/adopts version-specific **draft** PRs without candidate checkout,
history overwrite, readiness changes or merging.

`nix/pnpm.nix` must match Genie's `DEFAULT_AGGREGATE_PACKAGE_MANAGER`, Buck protocols,
the lock-mutator allowlist, active fixtures and default tests.
`scripts/update-pnpm.py` hashes seven raw registry tarballs and updates authored pins;
CI then runs one `genie:run`. Never hand-edit generated manifests or contracts.
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
