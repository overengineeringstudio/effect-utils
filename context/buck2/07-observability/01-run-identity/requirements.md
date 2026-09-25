# Run Identity Requirements

This subsystem owns the correlation between a caller's trace context and Buck
commands: the command span, the wrapper trace id exported as
`BUCK_WRAPPER_UUID`, the per-command sidecar line, and span-id salting. It
refines BUCK.OBS-R03 and BUCK.OBS-R07 of the
[07-observability requirements](../requirements.md).

## Assumptions

- **BUCK.OBS.ID-A01 Direct execution:** Buck runs as a direct child
  ([decision 0011](../../.decisions/0011-direct-native-evidence-observation.md));
  identity machinery prepares environment and spans only — never interposes.
- **BUCK.OBS.ID-A02 Buck parsing:** Buck lexically parses `BUCK_WRAPPER_UUID`
  (any 32-hex accepted; no version/variant validation) and a malformed or
  empty value fails the client at startup (measured rc=2).
- **BUCK.OBS.ID-A03 Span-id space:** Buck span ids are per-command counters
  that always include 0; every pair of commands' id sets intersects.

## Acceptable Tradeoffs

- **BUCK.OBS.ID-T01 One wrapper process per Buck command:** the `otel-span`
  buck2 mode costs one extra short-lived process (~ms) per Buck command;
  accepted for a single enforcement point over per-caller helpers that can
  drift (a drifted helper breaks builds).

## Requirements

- **BUCK.OBS.ID-R01 Command span per Buck command (refines BUCK.OBS-R03):**
  Every traced caller wraps each Buck command in a command span; task-level
  spans (e.g. the editor-view publish spans of #1382) stay caller-owned
  beneath the task span.
- **BUCK.OBS.ID-R02 Deterministic wrapper trace id:** The exported
  `BUCK_WRAPPER_UUID` is `uuidform(sha256(trace_id:command_span_id))` — a pure
  function of the caller context, so the sidecar line is derivable both ways.
- **BUCK.OBS.ID-R03 Validate before export (refines BUCK.OBS-R07):** The W3C
  context is validated (`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`) before
  export; invalid, empty, or all-zero values degrade to _unset_ — never to a
  malformed export.
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
