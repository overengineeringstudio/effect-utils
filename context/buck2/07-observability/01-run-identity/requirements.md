# Run Identity Requirements

This subsystem owns pipeline-run trace identity and the correlation between a
caller's trace context and Buck commands: the command span, the wrapper trace
id exported as `BUCK_WRAPPER_UUID`, the per-command sidecar line, and span-id
salting. It refines BUCK.OBS-R03 and BUCK.OBS-R07 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.ID-A01 Direct execution:** the caller invokes Buck directly
  ([decision 0011](../../.decisions/0011-direct-native-evidence-observation.md));
  the buck2 mode prepares the environment and span identity only and never
  runs or supervises Buck.
- **BUCK.OBS.ID-A02 Buck parsing:** Buck lexically parses `BUCK_WRAPPER_UUID`
  (any 32-hex accepted; no version/variant validation) and a malformed or
  empty value fails the client at startup (measured rc=2).
- **BUCK.OBS.ID-A03 Span-id space:** Buck span ids are per-command counters
  that always include 0; every pair of commands' id sets intersects.

## Acceptable Tradeoffs

- **BUCK.OBS.ID-T01 One preparation plus one post-hoc emit process:** the
  `otel-span` buck2 mode costs two short-lived processes (~ms each) per
  Buck command — one before (prepare) and one after (emit-span); accepted
  for a single enforcement point over per-caller helpers that can drift (a
  drifted helper breaks builds).
- **BUCK.OBS.ID-T02 Transitional devenv propagation:** Until devenv honors
  inbound W3C context, the entrypoint seeds both `TRACEPARENT` and
  `OTEL_TASK_TRACEPARENT`; the latter is removed once inbound propagation is
  fixed upstream.

## Requirements

- **BUCK.OBS.ID-R01 Command span per Buck command (refines BUCK.OBS-R03):**
  Every traced caller wraps each Buck command in a command span; task-level
  spans (e.g. the editor-view publish spans of #1382) stay caller-owned
  beneath the task span.
- **BUCK.OBS.ID-R02 Deterministic wrapper trace id:** The exported
  `BUCK_WRAPPER_UUID` is `uuidform(sha256(trace_id:command_span_id))` — a pure
  function of the caller context, so the sidecar line is derivable both ways.
- **BUCK.OBS.ID-R03 Validate before export (refines BUCK.OBS-R07):** The W3C
  context is validated (`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`, with
  nonzero trace and parent span ids) before export; invalid or empty values
  degrade to _unset_ — never to a malformed export.
- **BUCK.OBS.ID-R04 Sidecar line:** Each Buck command appends one line
  `<uuid> <traceparent-of-command-span>` to the run record's spool; the
  ingester uses it to parent `buck2.command` under the caller.
- **BUCK.OBS.ID-R05 Salted span ids:** Exported OTLP span ids are salted
  deterministically per command (a function of log identity and Buck span
  id), making concurrent and repeated commands collision-free and re-pushes
  idempotent.
- **BUCK.OBS.ID-R06 Nested and repeated commands:** Multiple Buck commands
  under one task (uquery + build; concurrent commands on one daemon) each get
  their own command span, wrapper trace id, sidecar line, and salt — one
  caller trace may hold sibling command roots.
- **BUCK.OBS.ID-R07 No context, no coupling:** With no valid OTEL context the
  wrapper exports nothing; Buck mints its own trace id and the adapter emits
  an independent trace (with a root link when only the task traceparent is
  known).
- **BUCK.OBS.ID-R08 One trace per pipeline run:** A local top-level verb or CI
  attempt has one deterministic seeded trace containing its run root, distinct
  matrix-qualified job spans, task spans, and Buck command spans. Attempts
  have distinct traces with a link to the prior attempt's root.
- **BUCK.OBS.ID-R09 Provider-neutral run identity:** `PIPELINE_RUN_ID` is
  `ci/<provider>/<repo>/<run>/<attempt>` in CI or `local/<uuid>` locally.
  The entrypoint mints it only when absent, and deriving trace and root span
  ids is deterministic, domain-separated, unambiguously framed, and
  W3C-nonzero. An already supplied identity is preserved.
- **BUCK.OBS.ID-R10 Exactly one completed run root:** Only the run identity
  owner writes its root: the local entrypoint on completion (including
  best-effort INT/TERM), or the CI ingester after an attempt-close roster
  settles, with a six-hour last-upload `incomplete` timeout if the close
  record is absent or listed jobs remain unaccounted for. Ingestion
  reconstructs a missing local root after kill/crash and synthesizes error
  spans for missing CI jobs; no first-job provisional or duplicate root is
  written.
- **BUCK.OBS.ID-R11 Context propagation and caller links:** The entrypoints
  seed W3C `TRACEPARENT`, prevent stale `OTEL_TASK_TRACEPARENT` from
  overriding it, and replace an outer caller trace instead of nesting under
  it. The new root always links back to the outer span; a forward link is
  written only by an outer-span owner that can record it before completion.
  Generic task instrumentation must join the seeded run trace.
- **BUCK.OBS.ID-R12 Bounded trace size:** Per-job traces linked through the
  run index remain the fallback when a whole-run trace exceeds the backend's
  usable size; a fallback does not silently split one run across random
  per-task traces.
- **BUCK.OBS.ID-R13 Consistent W3C validation:** The seeded entrypoint,
  `otel-span run`, and buck2 preparation reject W3C-invalid context equally
  (wrong version/case/width or all-zero trace or parent span id); an invalid
  context cannot split the task and its Buck view across traces. Valid
  trace flags are preserved through propagation.
