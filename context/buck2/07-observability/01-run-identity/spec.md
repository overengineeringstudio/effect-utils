# Run Identity Spec

This document specifies job and attempt-close trace identity and the
`otel-span` buck2 mode. It builds on [requirements.md](./requirements.md);
the local event-log adapter is [03](../03-event-log-adapter/spec.md).

## Status

Draft.

## Scope

**Defines:** run-id grammar, job/attempt trace derivation and links,
buck2 mode preparation, sidecar correlation, salting, and no-interposition
boundary.

**Does not define:** the otel-span CLI's general surface (devenv otel module),
the adapter that consumes the sidecar (03), or provider-specific CI wiring.

## Job and Attempt Traces (BUCK.OBS.ID-R08..R13)

```text
PIPELINE_RUN_ID ── job key ── deterministic job trace (job root)
                                      └── task-run spans ─ buck2.command ─ critical view
attempt close ── deterministic pipeline-run trace ── links to job roots
```

`PIPELINE_RUN_ID` is a provider-neutral, case-sensitive identifier owned by
the pipeline entrypoint. Grammar: `ci/<provider>/<repo>/<run>/<attempt>` or
`local/<uuid>`. CI components are nonempty UTF-8 values encoded as RFC 3986
percent-encoded bytes (uppercase hex escapes; unreserved bytes remain
literal); literal slashes separate components. `repo` contains the stable
namespaced repository identity. Attempt numbers are positive decimals without
leading zeros. The local UUID is lowercase RFC 4122 canonical form. The CI
adapter supplies the whole identifier; a local entrypoint mints `local/<uuid>`
only when absent. A present invalid or empty value warns and leaves telemetry
unseeded without failing the task (BUCK.OBS-R01). Examples:
`ci/github/overengineeringstudio%2Feffect-utils/421/2` and
`local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1` are valid;
`ci/github/repo/421` and `local/not-a-uuid` are invalid. Never use the
identifier verbatim as a filesystem path.

Identity inputs use `u32be(utf8 byte length) || utf8 bytes`, with each
domain separate. Truncate SHA-256 to 16 bytes for a trace id and 8 bytes
for a span id; if all zero, rehash with appended `u32be(counter)` starting at
1 until nonzero. Domains are
`buck2.job.trace/v1\0`, `buck2.job.root/v1\0`,
`buck2.pipeline-run.trace/v2\0`, and `buck2.pipeline-run.root/v2\0`.
The job input is `(run id, job key)`; the pipeline-run input is `(run id)`.
The job key includes a provider-neutral job identifier and a count followed
by sorted matrix dimension/value pairs, with each string length-prefixed.
CI retries change the attempt in `PIPELINE_RUN_ID`. A local task run uses
its verb and invocation identity as its job key. Nested task runs are spans
in the CI job trace, not separately seeded traces; the task executor
distinguishes repeated invocations by its task invocation identity.

In the generated GitHub workflow, the existing identity step supplies
`JOB_KEY` and `MATRIX_VALUE` (`matrix.runner` when present). The adapter
canonicalizes these into the same matrix-qualified key the Jobs API reporter
reconstructs from the job's name; this does not add per-job outputs or steps
to the workflow. A duplicate or unrecognizable provider job name is not
silently assigned another job's trace ID.

The job root carries `cicd.pipeline.run.id` and its job key. Task-run spans
are descendants of the job root; Buck command spans and critical views
retain the same trace id. A job root links back to an outer caller when one
exists. Attempt close emits a pipeline-run root with links to the known job
roots, using their deterministic ids, and `cicd.pipeline.run.id`. Its bounds
describe the attempt; it does not reparent job traces, synthesize absent jobs,
or await late span persistence. Each attempt has its own trace; a known
previous attempt root can be linked. No ingester owns a root: each job
emits at its own end directly to the configured OTLP endpoint, and the
attempt-close step emits the link trace. On delivery failure, keep the local
retry spool. No upload service, archived run record, SQLite index, replay,
or resolver participates in identity.

The generic entrypoint seeds `TRACEPARENT` for the job trace; nested task
invocations inherit that trace and parent their spans inside it. It clears
stale inherited `OTEL_TASK_TRACEPARENT` and, until devenv honors inbound W3C
context, seeds both variables identically; the pinned devenv executor and
shell hooks currently overwrite `TRACEPARENT`. Remove the transitional task
variable when inbound propagation is fixed. A new job trace links to an outer
caller rather than nesting in it; an outer-span owner can write the reverse
link only before that span completes. The task graph's `@completed` hook is
not an attempt finalizer: cancellation may skip it.

CI jobs join task spans into their job trace after the build and before
job-end export (#1477). The join must finish before the completed job trace
is sent; the attempt-close pipeline link trace can be sent independently of
Tempo search lag. There is no whole-run shared trace or size-triggered
switch to per-job traces.

## Mechanism

```text
caller task span (task run)
  ├─ otel-span buck2 mode  — PREPARES only, then exits (never runs Buck)
  │    1. pre-derive the command span id and record the start time
  │    2. read W3C context; validate regex
  │       ├─ valid  -> BUCK_WRAPPER_UUID = uuidform(sha256(trace_id:command_span_id))
  │       │            write local sidecar "<uuid> <traceparent-of-command-span>"
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

**Salting.** The adapter (03) salts OTLP span ids with the first 8 bytes of
`sha256("<log-uuid>:<buck-span-id>")` — deterministic from the log, unique
per command; the nested editor-publish reproduction showed 8,526/8,526
unique ids across two commands under one task trace, and sequential,
concurrent, and cross-daemon pairs all otherwise collide at least on id 0.

## Failure Behavior

| Condition                                 | Behavior                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No OTEL context outside a seeded task run | No wrapper export; the local adapter derives independent command views; no build impact                              |
| Invalid `TRACEPARENT` on a direct command | Treat as absent across `otel-span run` and buck2 prepare; never export an invalid Buck wrapper UUID                  |
| Invalid or empty `PIPELINE_RUN_ID`        | Warn and run the task without seeded telemetry; do not silently mint a different identity or change the build result |
| Sidecar append fails                      | Warn; the command view degrades to an independent root                                                               |
| Preparation process fails                 | Caller invokes Buck anyway without the env; build unaffected                                                         |
| Post-hoc emit fails                       | Ignored (fail-open); the command span is missing, the build result is unaffected                                     |

## Conformance

- W3C validation vectors: valid lowercase version `00` with both sampled
  and unsampled flags, uppercase, wrong version, short/long/nonhex ids,
  empty, zero trace id, zero parent id. `otel-span run` and buck2 prepare
  agree on valid inputs; valid flags survive child propagation.
- End-to-end: a job trace contains task-run and Buck critical-view spans
  whose `buck2.command` parent decodes to the command span id; a nested
  two-command task has zero id collisions; a
  concurrent same-daemon pair with distinct logs.
- Post-hoc emit: a completed command span with the pre-derived span id,
  measured start/end, and Buck's exit code appears in the caller's trace;
  a failed emit never changes the caller's exit code.
- Seeded identity: repeated derivation yields identical nonzero ids;
  different providers, attempts, matrix legs, and ambiguous-separator
  candidates yield distinct job trace ids. Every job root carries
  `cicd.pipeline.run.id`; nested tasks stay in their job trace.
- Lifecycle: each completed job exports its job trace at job end after the
  task-span join; attempt close exports one separate root linked to known
  job roots. Export failure retains the local retry spool. Neither missing
  jobs nor absent task traces are synthesized by a server. A new trace links
  back to an outer caller; only a participating owner writes a forward link
  before its span ends. Stale task context cannot override either seed.
- Seeded-run evidence: [traceparent bakeoff](./.experiments/2026-09-26-seeded-run-trace.md)
  and [decision 0002](./.decisions/0002-seeded-pipeline-run-trace.md).
- Caller-correlation evidence: [caller-correlation bakeoff](./.experiments/2026-09-25-caller-correlation-and-salting.md)
  and [decision 0001](./.decisions/0001-otel-span-buck2-mode.md).
