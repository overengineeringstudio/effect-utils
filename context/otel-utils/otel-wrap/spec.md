# Spec: otel-wrap

How the universal wrap + root/session floor composes `otel-core` primitives.
Builds on [requirements.md](./requirements.md) and refines the family composition
contract [../spec.md](../spec.md) — the single normative home for the wrap
primitive, mint/join precedence, and state-dir contract, which this spec
references rather than restates.

## Status

Draft.

## Scope

**Defines:** the two-verb CLI; how each verb composes `otel-core` primitives; the
`root begin|end` state model over the shared `sessions/` store.

**Does not define:** the primitives themselves (see [../spec.md](../spec.md)); the
adapter registry (that is `otel-scrape`).

## Package Boundary

`otel-wrap` is a Rust bin crate under `packages/@overeng/otel-wrap`, producing a
CLI binary named `otel-wrap`, following the `otelite`/`otel-scrape` packaging
pattern. It depends on the `otel-core` library and adds only its CLI surface.

## CLI

```
otel-wrap [--root|--join] [--attr k=v]... -- <cmd...>   # wrap one command
otel-wrap root begin [--attr k=v]...                    # open a persisted root span
otel-wrap root end                                      # close it
```

Two verbs only (family decision 0005). No standalone emit-span verb.

### Command verb

```
otel-wrap [--root|--join] [--attr k=v]... -- <cmd...>:
  ├─ resolve root-or-join via otel_core::context mint/join precedence
  │    --join → join inbound traceparent; --root → mint; absent → precedence
  ├─ otel_core::wrap: spawn <cmd>, capture, own the command span
  │    (--attr k=v attributes attached to the command span)
  ├─ export command-span context to the child (TRACEPARENT / OTEL_TASK_TRACEPARENT)
  ├─ emit via otel_core::export (disabled-mode = transparent passthrough)
  ├─ on root-mint + active telemetry → otel_core::surface trace id/URL (stderr)
  └─ preserve child stdout/stderr/exit
  exit code = child's exit code
```

This is the task-layer floor. A task body is wrapped as
`otel-wrap --attr task.name=<name> -- <task-body>`, replacing the legacy
`otel-run` / `otel-span run` path (requirement R09). Because it composes the same
mint/join precedence as `otel-scrape`, a nested `otel-scrape` command joins the
`otel-wrap` command span with no post-hoc stitching.

### Root/session verb

```
otel-wrap root begin:
  ├─ resolve root-or-join via mint/join precedence
  ├─ construct a root span (otel_core::span)
  └─ persist it OPEN into <state-dir>/sessions/<session-id>   # no daemon
otel-wrap root end:
  ├─ read the open span from <state-dir>/sessions/<session-id>
  ├─ close it (end time, final attributes)
  └─ emit via otel_core::export
```

`begin` and `end` are separate stateless processes; the only shared state is the
`sessions/` file (family decision 0007). The persisted open span reuses the
`otel-core` span model — it is **identity-addressed and mutable**, distinct from
CAS's content-addressed write-once objects (see
[../spec.md](../spec.md#state-dir-contract)). No resident process holds the root
open between `begin` and `end`.

## Composition Map

| `otel-wrap` behavior | `otel-core` primitive |
| -------------------- | --------------------- |
| Command wrap, passthrough, disabled transparency | `otel_core::wrap` (requirement R03/R05) |
| Root-or-join | `otel_core::context` mint/join precedence (R04) |
| Command span + attributes | `otel_core::span` |
| Emission | `otel_core::export` behind the serializer seam |
| Root-mint surfacing | `otel_core::surface` (terminal-only, R06) |
| `root begin|end` state | `otel_core::state_dir` `sessions/` + `otel_core::span` (R07) |
| Public-safe sinks | `otel_core::trust` (R08) |

`otel-wrap` adds no primitive; every row is a composition (family requirement
R01/R14).

## Relationship To Legacy Tools

- **otel-run** → the command verb. `otel-run`'s root minting is the command verb's
  root-or-join.
- **otel-span run** → the command verb with `--attr task.name=…`. The task-layer
  span is a `otel-wrap` command span.
- **otel-span (standalone emit)** → dropped. Emitting a structured span from tool
  output moves to `otel-scrape` adapters (requirement R03).
- **spool transport** → dropped. Root/session state is a persisted open span in
  `sessions/`, not a file spool.

The replacement is not gated on native devenv OTLP; `devenv --trace-to` becomes a
later optional upgrade the universal root model (family decision 0006) already
admits as a principled native root.
