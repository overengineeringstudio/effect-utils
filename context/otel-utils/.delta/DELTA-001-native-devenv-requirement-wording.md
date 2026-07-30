# DELTA-001: draft requirements overstate otel-wrap's devenv role

**Status:** Open

## Divergence

The draft family and otel-wrap requirements still describe `otel-wrap` as a
task-layer replacement for `otel-span` and native devenv tracing as a later
optional upgrade. The current implementation and mutable spec instead assign
devenv orchestration to native devenv and repository capture to
`devenvModules.observability`.

## Why it stands

`requirements.md` is protected. This reconciliation was authorized to preserve
and align the draft VRS, but did not include explicit maintainer confirmation to
change constitutional requirements.

## Current Implementation

- Native devenv owns root, evaluation, and aggregate task spans.
- `devenvModules.observability` owns reusable otelite capture, profile, and
  verification tasks.
- Its effect-utils producer temporarily preserves status/exec phase detail while
  [cachix/devenv#3037](https://github.com/cachix/devenv/issues/3037) is open.
- `otel-wrap` is scoped to commands and sessions without a native orchestrator.

## Resolution

After maintainer confirmation, update family R03–R06 and otel-wrap R01/R09 to
match the current ownership boundary, then remove this delta.
