# Requirements: pnpm adapter

Role: the reference phase-lane adapter. This leaf states only pnpm-specific
testable constraints; inherited contract rules are not restated.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and the parent
  contract [../../requirements.md](../../requirements.md).
- Source evidence + isolation hazard:
  [../.experiments/0002-pnpm-ndjson-and-isolation-hazard.md](../.experiments/0002-pnpm-ndjson-and-isolation-hazard.md).
- Ranked first candidate:
  [../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md](../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md).

## Requirements

- **ADP.PNPM-R01 Phase spans only** (refines ADP-R03): the adapter emits at most
  the `pnpm.resolve` and `pnpm.import` spans (from `pnpm:stage` start/stop
  pairs). Per-package records (`pnpm:progress`, `pnpm:link`) never become spans.
- **ADP.PNPM-R02 Respect user reporter** (refines parent R30): `--reporter=ndjson`
  is injected only when the invocation does not already specify a reporter
  (`--reporter`/`-s`); an explicit user reporter disables adapter parsing rather
  than overriding it.
- **ADP.PNPM-R03 Gated package identity** (refines parent R27, parent decision
  0015): `packageId`, `requester`, `wanted`, `realName`, and all local paths are
  dropped from every sink by default; package identity is admitted only into a
  sink explicitly asserted private via `--trusted-sink`.
- **ADP.PNPM-R04 Behavior-preserving** (refines parent R03): the adapter never
  injects flags that change install behavior — in particular not
  `--config.confirmModulesPurge` — and never alters the passthrough exit code.
- **ADP.PNPM-R05 Install-scope** (refines ADP-R04): the adapter engages only for
  install-class invocations (`install`/`i`/`add`/`update`). The frozen
  `lint:check:lockfile` task, whose stream is near-empty, stays command-span-only
  unless DQ-pnpm-2 resolves otherwise.
