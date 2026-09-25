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
  └─ otel-span buck2 mode
       1. open command span "buck2.command <subcommand>"
       2. read W3C context; validate regex
          ├─ valid  -> BUCK_WRAPPER_UUID = uuidform(sha256(trace_id:command_span_id))
          │            append sidecar "<uuid> <traceparent-of-command-span>"
          └─ invalid/absent/all-zero -> export nothing
       3. exec buck2 ... --event-log <path> --write-build-id <path>   (direct, 0011)
       4. close command span with exit status
```

The mode is caller-side preparation, not interposition: Buck remains a direct
child; the wrapper never sits between the caller and Buck's stdio, signals, or
result. This is the standing 0011 boundary; the amendment records it
explicitly.

**Call sites.** The devenv task shell (`trace.exec`), TypeScript subprocess
spawners (the #1382 `otel-span emit-span` pattern), and CI job wrappers all
invoke the same mode; there is exactly one implementation of the validation
invariant (BUCK.OBS.ID-T01).

**Salting.** The adapter (03) salts OTLP span ids as
`sha256("<log-uuid>:<buck-span-id>")[:16]` — deterministic from the log, unique
per invocation; the nested editor-publish reproduction showed 8,526/8,526
unique ids across two commands under one task trace, and sequential,
concurrent, and cross-daemon pairs all otherwise collide at least on id 0.

**Daemon sharing.** Wrapper trace ids stay unique per invocation even when
commands share a daemon (Buck re-reads the env per client invocation); two
interleaved commands on one daemon produced two distinct logs keyed by their
uuids with no cross-contamination. Daemon waits themselves are attributed at
ingest ([03](../03-event-log-adapter/spec.md)).

## Failure Behavior

| Condition                       | Behavior                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| No OTEL context                 | No export; independent trace; no build impact                                          |
| Malformed / empty `TRACEPARENT` | Treated as absent (never exported — Buck fails on malformed `BUCK_WRAPPER_UUID`, rc=2) |
| All-zero trace id               | Treated as absent                                                                      |
| Sidecar append fails            | Warn; the trace degrades to an independent root                                        |
| Wrapper process failure         | Caller proceeds without the env; build unaffected                                      |

## Conformance

- Validation test vectors: valid traceparent, uppercase, simple (no-hyphen)
  32-hex, 31/33 hex, non-hex, empty, all-zero — only the valid forms export.
- End-to-end: a real task trace whose `buck2.command` parent decodes to the
  command span id; a nested two-command task with zero id collisions; a
  concurrent same-daemon pair with distinct logs.
- Evidence: [caller-correlation bakeoff](./.experiments/2026-09-25-caller-correlation-and-salting.md)
  and [decision 0001](./.decisions/0001-otel-span-buck2-mode.md).
