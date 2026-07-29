# 0002 - Root-workspace runner telemetry is an explicit test-module capability

Status: accepted

## Context

Vitest native OpenTelemetry is configured once in a root workspace config, but
the reusable devenv test module historically runs each package from its own
directory and config. Unconditionally changing all package tasks to `--project`
would require every downstream repository to have effect-utils' root-workspace
shape and would break consumers that intentionally use only package-local
configs.

The observability lifecycle is already owned by
`devenvModules.observability` and its otelite profiles. This decision only
defines how a test task opts into the native Vitest runner lane when such a
collector context exists.

## Decision

- `devenvModules.tasks.test` keeps package-local execution as its default.
- A consumer with a root Vitest workspace explicitly sets
  `vitestWorkspaceRoot`.
- In that mode, each package task resolves its package-local Vitest binary
  before changing directory, then runs the corresponding root `--project`.
- The task sets `VITEST_OTEL_RUNNER=1` only when the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT` is present. It does not start, stop, or configure
  an observability backend.
- effect-utils self-hosts the capability with `vitestWorkspaceRoot = "."`.

## Consequences

- Downstream consumers retain their existing working directory and
  package-local config unless they opt in.
- Native runner telemetry composes with the lifecycle delivered by #970/#973
  without duplicating otelite or devenv orchestration in the test module.
- A root workspace must keep project names aligned with the test module's
  package names.
