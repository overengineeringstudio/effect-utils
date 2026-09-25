# 0001 otel-span buck2 Mode Owns Caller Correlation

Status: accepted

Accepted 2026-09-25 (decision q11; Johannes), with round-2 correlation
evidence (B5).

## Context

A caller's trace must contain the Buck command's full span tree. Buck accepts
a caller-chosen `BUCK_WRAPPER_UUID` but only parses it lexically: any 32-hex
value is accepted, while a malformed or empty value fails the client at
startup (measured rc=2) — validation is load-bearing. Buck call sites are
scattered (devenv task shells, TypeScript subprocess spawners, Nix builds,
composition scripts), so the invariant must have one enforcement point.

## Evidence and Argument

- The derived-uuid scheme was verified end-to-end in Tempo: exporting
  `BUCK_WRAPPER_UUID` from the caller's W3C trace id parents `buck2.command`
  exactly under the caller's task span (9,831 spans in one trace); the links
  alternative leaves Buck traces discoverable only from the Buck side
  ([experiment](../.experiments/2026-09-25-caller-correlation-and-salting.md)).
- A 12-case env matrix (source-validated plus empirical) proves Buck does no
  version/variant checking and fails on every non-32-hex value including
  empty.
- Nested commands (a real editor publish: uquery + build under one task)
  land as two sibling command roots with 8,526/8,526 unique salted ids;
  concurrent commands on one daemon keep distinct uuids and logs.
- #1382 (merged) established the TypeScript→otel-span pattern for per-command
  spans; the mode generalizes it.

## Options

| Option                         | Tradeoff                                                                                         | Outcome  |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | -------- |
| `otel-span` buck2 mode         | One enforcement point in the existing caller-side tracer; one extra ~ms process per Buck command | Accepted |
| Per-caller helpers (bash + TS) | No extra process; the invariant is implemented twice and drift breaks builds (rc=2)              | Rejected |
| Nix wrapper around buck2       | Automatic coverage; reopens 0011's rejected interposition                                        | Rejected |

## Decision

`otel-span` gains a buck2 mode that opens the command span, validates the W3C
context, exports `BUCK_WRAPPER_UUID = uuidform(sha256(trace_id:command_span_id))`
or leaves it unset, and appends the sidecar line
`<uuid> <traceparent-of-command-span>` to the run-record spool. `trace.nix`
and the TypeScript call sites use it; exported OTLP span ids are salted per
command (the adapter applies the salt; BUCK.OBS.ID-R05).

## Consequences

- Correlation is a pure function of the sidecar: trace id, parent span id, and
  build correlation all derive from one line per command.
- Bad contexts degrade to _unset_ — a build never fails from telemetry input.
- The mode is caller-side preparation, not interposition (0011 Amendment 1);
  a measured gap would still be required before any observer process.
