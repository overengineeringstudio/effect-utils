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

## Job and Attempt Traces (BUILD.BUCK.OBS.ID-R08..R13)

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
unseeded without failing the task (BUILD.BUCK.OBS-R01). Examples:
`ci/github/overengineeringstudio%2Feffect-utils/421/2` and
`local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1` are valid;
`ci/github/repo/421` and `local/not-a-uuid` are invalid. Never use the
identifier verbatim as a filesystem path.

`F(value)` is `u32be(length of UTF-8 bytes) || UTF-8 bytes`.
`K(job, dimensions)` is `F(job) || u32be(number of dimensions)` followed
by `F(name) || F(value)` for each dimension sorted by the UTF-8 bytes of its
name. Dimension names are unique, nonempty and case-sensitive; values are
nonempty, unnormalized UTF-8. The trace/root preimage is the corresponding
ASCII domain followed by `F(run id) || K(job, dimensions)` for a job, or
`F(run id)` for the pipeline root. Domains are
`buck2.job.trace/v1\0`, `buck2.job.root/v1\0`,
`buck2.pipeline-run.trace/v2\0`, and `buck2.pipeline-run.root/v2\0`.
Truncate SHA-256 to 16 bytes for trace IDs and 8 bytes for span IDs; if
all zero, rehash the original preimage with appended `u32be(counter)` from
1 until nonzero. No stringified `job[runner=value]` is hashed.

The shell identity producer frames and hashes inside a subshell with
`LC_ALL=C`. This counts bytes independently of the caller's locale without
restoring an ambient native locale in a forked hashing pipeline; commands
wrapped by `pipeline-run` retain their own locale.

In CI, `job` is the workflow job identifier. The generated GitHub workflow
already supplies it as `JOB_KEY`; its sole current matrix dimension is
`runner`, supplied by `MATRIX_VALUE` (`matrix.runner`). For example,
`K("test", {"runner":"namespace-profile-linux-x86-64"})` encodes
`F("test") || u32be(1) || F("runner") ||
F("namespace-profile-linux-x86-64")`; `K("typecheck", {})` ends in
`u32be(0)`. If the workflow adds a matrix dimension, the producer must
receive its name and value through the existing identity step before it
can derive a trace ID; neither the finalizer nor reporter invents it.
CI retries change the attempt in `PIPELINE_RUN_ID`. A local task run uses
its verb as `job` and `{"invocation": <task invocation ID>}` as dimensions.
Nested task runs are spans in the CI job trace, not separately seeded
traces; the task executor distinguishes repeated invocations.

The GitHub adapter constructs a finite mapping from the generated workflow
job declarations to the exact GitHub Actions Jobs API `name`: an ordinary
job's declared display name (or job identifier if unnamed), and each
enumerated matrix leg's rendered display name in declaration order. It
maps the name back to the job identifier and the named matrix values, then
applies `K` identically in producer, finalizer and reporter. For the current
`runner` matrix, `test (namespace-profile-linux-x86-64)` maps to
`K("test", {"runner":"namespace-profile-linux-x86-64"})`.
Unknown, dynamically named or duplicate display names are unmatched;
they cannot be assigned a guessed trace ID. This mapping reads Jobs API
facts, not per-job outputs, and adds no workflow YAML.

The CI identity step records the job start time. Each CI task step emits only
its task-run span beneath the deterministic job root; the always-run job-end
adapter emits that root exactly once, using the recorded start, its export
time as the end, and GitHub's whole-job status (`success` maps to OK; other
statuses map to ERROR). `cicd.pipeline.task.run.result` records the normalized
job outcome from the official v1.44.0
[CICD registry](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/model/cicd/registry.yaml)
([span convention](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/cicd/cicd-spans.md#pipeline-task-run)).
GitHub jobs are tasks within a workflow pipeline; the job root is not the
workflow's pipeline-result span.

| GitHub conclusion / job status                                    | `cicd.pipeline.task.run.result` |
| ----------------------------------------------------------------- | ------------------------------- |
| `success`                                                         | `success`                       |
| `failure`                                                         | `failure`                       |
| `cancelled`                                                       | `cancellation`                  |
| `skipped`                                                         | `skip`                          |
| `timed_out`                                                       | `timeout`                       |
| `action_required`, `neutral`, `stale`, `startup_failure`, unknown | `error`                         |

The job-end hook receives only GitHub's `success`, `failure`, or `cancelled`
job-status context today; the remaining conclusions are normalized if supplied.
For a local invocation, zero exit maps to `success`, nonzero exit to `failure`,
and a received INT/TERM signal to `cancellation`. Provider and fork provenance
use `vcs.provider.name` and `buck2.vcs.change.is_fork`, with namespace ownership,
types and absent-value behavior defined in
[05's attribute contract](../05-otlp-delivery/spec.md#semantic-attribute-contract).
The root carries `cicd.pipeline.run.id` and its job key. Buck command spans
and critical views retain the same trace id. For a standalone local task run,
the generic entrypoint emits its own root at completion. A job root links
back to an outer caller when one exists. At attempt close, the finalizer
pages the Jobs API (`filter=all`) for this run
and links each latest-attempt job at its execution attempt. A partial
rerun reports carried-over jobs under the new `run_attempt`; such a job keeps
its execution attempt, the earliest attempt whose same-named job has identical
`started_at` and `completed_at`. It excludes its own job
and includes only jobs with `started_at` and a unique canonical `K` under
the same name mapping used by the reporter (failed and cancelled jobs that
started are included; skipped and unstarted jobs are not). It derives their
job root trace/span IDs and writes one pipeline root with links marked
`buck2.job_trace.link_state=unverified`: the API proves that a job started,
not that its root was sent, accepted, or retained by the backend. A link to an
absent root is therefore possible and is never shown as proof of delivery.
Its bounds describe the attempt; it does not reparent job traces, synthesize
absent jobs, or await late span persistence.
Each attempt has its own trace; a known previous attempt root can be linked.
No ingester owns a root: each job exports to the configured OTLP endpoint
at its own end, and attempt close exports the link trace. A delivery
failure keeps the local retry spool. No upload service, archived run
record, SQLite index, replay, or resolver participates in identity.

The link attribute `buck2.job_trace.link_state` belongs to this repository's
private lowercase dotted `buck2.job_trace.*` namespace, not OTel semconv.
Its only valid value is the lowercase string `unverified`; the link always
remains a locator, never a persistence assertion. Readers that do not
understand the key or encounter an unknown value treat the link as
unverified, not as proof of export. For example,
`buck2.job_trace.link_state=unverified` is valid;
`buck2.job_trace.link_state=complete` is invalid. It records link
confidence, not job conclusion or OTLP transport status; those axes
cannot be inferred from it.

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
backend search lag. There is no whole-run shared trace or size-triggered
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
implementation of the validation invariant (BUILD.BUCK.OBS.ID-T01).

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
- Seeded identity: repeated derivation yields identical nonzero IDs;
  different providers, attempts, matrix legs, names with separator
  characters, and dimension orderings have unambiguous framed bytes. The
  producer's `JOB_KEY=test, MATRIX_VALUE=namespace-profile-linux-x86-64`
  and the Jobs API `test (namespace-profile-linux-x86-64)` resolve to
  identical `K`; an unknown or duplicate name gets no guessed trace ID.
  Every job root carries `cicd.pipeline.run.id`; nested tasks share its
  trace.
- Lifecycle: each completed job exports its job trace at job end after
  the task-span join. Attempt close takes the latest attempt's started,
  uniquely mapped rows from `filter=all`, including started failed/cancelled
  jobs, links each at its execution attempt, and drops unstarted/skipped
  rows and rows listed only under earlier attempts. Links carry
  `buck2.job_trace.link_state=unverified`, even if the root never arrived
  in the backend. Export failure retains the local retry spool; no server
  synthesizes missing jobs. A new trace links back to an outer caller;
  only a participating owner writes a forward link before its span ends.
  Stale task context cannot override either seed.
- Seeded-run evidence: [traceparent bakeoff](.experiments/2026-09-26-seeded-run-trace.md)
  and [decision 0002](.decisions/0002-seeded-pipeline-run-trace.md).
- Caller-correlation evidence: [caller-correlation bakeoff](.experiments/2026-09-25-caller-correlation-and-salting.md)
  and [decision 0001](.decisions/0001-otel-span-buck2-mode.md).
