# Run Identity Spec

This document specifies the `otel-span` buck2 mode and the identity contract.
It builds on [requirements.md](./requirements.md); the run record that
consumes the sidecar is [02-run-record](../02-run-record/spec.md).

## Status

Draft.

## Scope

**Defines:** the buck2 mode's behavior, the derivation and validation
contract, the sidecar format, salting, and the no-interposition boundary.

**Does not define:** the otel-span CLI's general surface (devenv otel module),
the adapter that consumes the sidecar (03), or CI workflow wiring.

## Mechanism

```text
caller task span (task run)
  ├─ otel-span buck2 mode  — PREPARES only, then exits (never runs Buck)
  │    1. pre-derive the command span id and record the start time
  │    2. read W3C context; validate regex
  │       ├─ valid  -> BUCK_WRAPPER_UUID = uuidform(sha256(trace_id:command_span_id))
  │       │            append sidecar "<uuid> <traceparent-of-command-span>"
  │       └─ invalid/absent/all-zero -> export nothing
  │    3. hand the caller the derived env + span id, and exit
  ├─ caller invokes buck2 ... --event-log <path> --write-build-id <path>
  │    directly (task shell or TS spawn; nothing sits between — 0011)
  └─ after Buck exits: caller emits the completed command span post hoc —
       otel-span emit-span <service> "buck2.command <subcommand>"
         --span-id <pre-derived id> --start-time-ns <start> --end-time-ns <end>
         --status-code ok|error --attr-int exit.code=<n>
       (fail-open: emit failures are ignored)
```

The mode is **preparation plus post-hoc completion**, never supervision. No
process sits between the caller and Buck: the caller invokes Buck directly
with the prepared environment, and after Buck exits the caller completes the
command span itself, exactly the #1382 pattern (`emitCompletedSpan` in
buck2-tools: fire-and-forget, failures swallowed). `otel-span emit-span`
already accepts a caller-chosen span id (`--span-id`, with `--trace-id`,
`--parent-span-id`, explicit start/end nanoseconds, and status), so the
post-hoc emit needs no new CLI capability — the buck2 mode only fixes _which_
id to pass. This keeps the standing 0011 boundary intact; the amendment
records it explicitly.

**Call sites.** The devenv task shell (`trace.exec`), TypeScript subprocess
spawners (the #1382 `otel-span emit-span` pattern), and CI job wrappers all
use the same preparation and the same post-hoc emit; there is exactly one
implementation of the validation invariant (BUCK.OBS.ID-T01).

**Salting.** The adapter (03) salts OTLP span ids as
`sha256("<log-uuid>:<buck-span-id>")[:16]` — deterministic from the log, unique
per command; the nested editor-publish reproduction showed 8,526/8,526
unique ids across two commands under one task trace, and sequential,
concurrent, and cross-daemon pairs all otherwise collide at least on id 0.

## Failure Behavior

| Condition                       | Behavior                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| No OTEL context                 | No export; both views become derived traces (05); no build impact                      |
| Malformed / empty `TRACEPARENT` | Treated as absent (never exported — Buck fails on malformed `BUCK_WRAPPER_UUID`, rc=2) |
| All-zero trace id               | Treated as absent                                                                      |
| Sidecar append fails            | Warn; the trace degrades to an independent root                                        |
| Preparation process fails       | Caller invokes Buck anyway without the env; build unaffected                           |
| Post-hoc emit fails             | Ignored (fail-open); the command span is missing, the build result is unaffected       |

## Conformance

- Validation test vectors: valid traceparent, uppercase, simple (no-hyphen)
  32-hex, 31/33 hex, non-hex, empty, all-zero — only the valid forms export.
- End-to-end: a real task trace whose `buck2.command` parent decodes to the
  command span id; a nested two-command task with zero id collisions; a
  concurrent same-daemon pair with distinct logs.
- Post-hoc emit: a completed command span with the pre-derived span id,
  measured start/end, and Buck's exit code appears in the caller's trace;
  a failed emit never changes the caller's exit code.
- Evidence: [caller-correlation bakeoff](./.experiments/2026-09-25-caller-correlation-and-salting.md)
  and [decision 0001](./.decisions/0001-otel-span-buck2-mode.md).
