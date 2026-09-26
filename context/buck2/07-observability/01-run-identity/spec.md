# Run Identity Spec

This document specifies pipeline-run identity and the `otel-span` buck2 mode.
It builds on [requirements.md](./requirements.md); the run record that
consumes the sidecar is [02-run-record](../02-run-record/spec.md).

## Status

Draft.

## Scope

**Defines:** the run-id seed and root ownership, the buck2 mode's behavior,
derivation and validation, sidecar format, salting, and no-interposition
boundary.

**Does not define:** the otel-span CLI's general surface (devenv otel module),
the adapter that consumes the sidecar (03), or provider-specific CI wiring.

## Seeded Pipeline-Run Trace (BUCK.OBS.ID-R08..R12)

```text
local entrypoint ── mint if absent ──┐
CI adapter ── supply run identity ───┴─ PIPELINE_RUN_ID ── deterministic trace
                                           ├─ root (local entrypoint or CI ingester)
                                           └─ job key (including matrix) ─ task ─ buck2.command
```

`PIPELINE_RUN_ID` is a provider-neutral, case-sensitive identifier owned by
the pipeline-run entrypoint. Grammar: `ci/<provider>/<repo>/<run>/<attempt>`
or `local/<uuid>`. Every CI component is a nonempty UTF-8 value encoded
as RFC 3986 percent-encoded bytes (uppercase hex escapes; leave unreserved
bytes literal), with literal slashes reserved exclusively for separators;
`repo` encodes the stable repository identity including its namespace.
Decimal attempt numbers are positive without leading zeros. The local UUID
is lowercase RFC 4122 canonical form. The CI adapter supplies the full
identifier including the attempt; the local entrypoint mints
`local/<uuid>` only when the variable is absent. A present but invalid/empty
value is reported as invalid telemetry identity, never silently replaced
with another ID; the task still runs without seeded telemetry
(BUCK.OBS-R01). For example
`ci/forge/repo%2Fmodule/421/2` and
`local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1` are valid;
`ci/forge/repo/421` and `local/not-a-uuid` are invalid. Values are never
made into host paths verbatim.

Derive the 16-byte W3C trace id from the first 16 bytes of SHA-256 over
`"buck2.pipeline-run.trace/v1\0" || u32be(byte_length(id)) || utf8(id)`.
Derive the 8-byte run-root span id analogously with domain
`"buck2.pipeline-run.root/v1\0"`. If a truncated id is all zero, retry with
`u32be(counter)` appended (counter starts at 1) until nonzero. Each job's
8-byte span id uses its own `"buck2.pipeline-run.job/v1\0"` domain and two
length-prefixed UTF-8 inputs (run id, job key), with the same zero guard.
No bare concatenation, ambiguous separator, random reseed, or zero-valued
W3C identifier. Each attempt is a distinct trace; its root links to the
previous attempt's root when that attempt exists.

The job key combines the provider-neutral job identifier with canonical
matrix dimension/value pairs sorted by dimension name; encode each string as
`u32be(utf8 byte length) || utf8 bytes`, preceded by a pair count. This
distinguishes matrix variants even when a provider reuses the same job name.
For the worker/job span, seed `TRACEPARENT` as
`00-<derived-trace-id>-<derived-job-span-id>-01`. The run identity owner
alone writes the root: locally the generic `devenv tasks run <verb>`
entrypoint records start/end around the child and writes both root and
worker span at exit (including best-effort SIGINT and SIGTERM without
masking the child's exit status); nested invocations inheriting that id
do not emit another root. In CI the ingester writes the root after the job
set is sealed or a completion timeout, using run/job bounds and inventory.
It also reconstructs a missing local root after SIGKILL/crash when a record
is recovered and synthesizes missing CI job spans. A first-job root would
freeze incorrect bounds; spans cannot be updated and duplicate root ids
persist in Tempo. Until the late root arrives, the index-backed resolver
serves the run; a trace viewer may show an orphan job temporarily.

The same generic entrypoint runs locally and from the CI adapter. It accepts
a valid caller W3C context only to link the old outer span to the new root
and the new root back to the old span; it replaces rather than parents the
run under the old trace. It clears any inherited `OTEL_TASK_TRACEPARENT`
before seeding. During the devenv transition, it seeds **both**
`TRACEPARENT` and `OTEL_TASK_TRACEPARENT` with the same run/job context:
the pinned devenv executor and shell hooks overwrite `TRACEPARENT`, while
otel-span prefers `OTEL_TASK_TRACEPARENT`. Generic SDKs reading only
`TRACEPARENT` do not yet join reliably. Fix devenv upstream to extract
ambient inbound W3C context and stop shell-hook overrides; then delete
`OTEL_TASK_TRACEPARENT` seeding and consume only W3C `TRACEPARENT`.
Never let a stale inherited task variable select another trace. The task
graph's `@completed` hook is not a root finalizer: cancellation skips it
and it can mask failures.

Whole-run traces are the default; if backend size limits make them unusable,
seed a trace per matrix-qualified job and link job roots through the run
index, without reverting to random per-task traces. Ingestion verifies each
job's expected span ids against settled by-id readback before claiming
completeness: an accepted OTLP batch is not proof of persistence across
long gaps between job arrivals. See the [loss evidence](./.experiments/2026-09-26-seeded-run-trace.md).
The record's pre-manifest identity and VCS metadata remain defined by
[02-run-record](../02-run-record/spec.md).

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

| Condition | Behavior |
| --- | --- |
| No OTEL context outside a seeded run | No export; both views become derived traces (05); no build impact |
| Invalid `TRACEPARENT` on a direct command | Treat as absent across `otel-span run` and buck2 prepare; never export an invalid Buck wrapper UUID |
| Invalid or empty `PIPELINE_RUN_ID` | Warn and run the task without seeded telemetry; do not silently mint a different identity or change the build result |
| Sidecar append fails | Warn; the command view degrades to an independent root |
| Preparation process fails | Caller invokes Buck anyway without the env; build unaffected |
| Post-hoc emit fails | Ignored (fail-open); the command span is missing, the build result is unaffected |

## Conformance

- W3C validation vectors: valid lowercase version `00` with both sampled
  and unsampled flags, uppercase, wrong version, short/long/nonhex ids,
  empty, zero trace id, zero parent id. `otel-span run` and buck2 prepare
  agree on valid inputs; valid flags survive child propagation.
- End-to-end: a real task trace whose `buck2.command` parent decodes to the
  command span id; a nested two-command task with zero id collisions; a
  concurrent same-daemon pair with distinct logs.
- Post-hoc emit: a completed command span with the pre-derived span id,
  measured start/end, and Buck's exit code appears in the caller's trace;
  a failed emit never changes the caller's exit code.
- Seeded identity: repeated derivation yields identical nonzero ids;
  different providers, attempts, matrix legs, and ambiguous-separator
  candidates yield distinct ids. Nested local invocations inherit one run
  without duplicate roots; independent invocations mint distinct ids.
- Lifecycle: CI ingester emits one bounded root after completion and
  reconstructs missing job spans; the local entrypoint preserves success,
  failure, INT and TERM statuses, and missing roots after kill are
  reconstructed. An outer caller has links in both directions but is
  not the run's parent; stale task context cannot override either seed.
- Seeded-run evidence: [traceparent bakeoff](./.experiments/2026-09-26-seeded-run-trace.md)
  and [decision 0002](./.decisions/0002-seeded-pipeline-run-trace.md).
- Caller-correlation evidence: [caller-correlation bakeoff](./.experiments/2026-09-25-caller-correlation-and-salting.md)
  and [decision 0001](./.decisions/0001-otel-span-buck2-mode.md).
