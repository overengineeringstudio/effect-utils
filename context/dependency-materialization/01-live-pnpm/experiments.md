# Live pnpm Experiments

This file records non-normative live pnpm evidence. Normative behavior lives in
[spec.md](./spec.md).

## CI Cache Boundary

Hypothesis:

- CI should cache the pnpm store directory as the primary warm-install
  boundary.

Result:

- Rejected for the measured pnpm 11 + GVS model. Warm installs reused more of
  the hot path when the pnpm home was restored than when only the store
  directory was restored.

Conclusion:

- CI cache policy should describe the full profile hot state instead of
  assuming `store-dir` alone is the reusable boundary.

## Setup/Fan-Out Archive

Hypothesis:

- One setup job can install once, archive the prepared live state, and fan it
  out to sibling jobs more cheaply than each sibling running a warm install.

Result:

- Rejected for the explored self-hosted runner shape. Archive pack and restore
  cost outweighed the warm install savings.

Conclusion:

- Live setup/fan-out must beat the current warm path in integrated benchmarks,
  not only in synthetic copy tests.

## Runner-Local Seed

Hypothesis:

- A runner-local seed of shared package content plus job-local metadata can
  preserve isolation and reduce install time.

Result:

- Rejected in the explored implementation. Synthetic hardlink tests looked
  promising, but integrated install benchmarks were slower than the current
  warm path and exposed pnpm store-version portability issues.

Conclusion:

- Future seed traits need real-workspace benchmarks, parallel stress, and
  pnpm-version portability proof before becoming defaults.
