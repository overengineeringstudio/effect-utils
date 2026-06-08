# restate-effect — Glossary

Domain language for the `@overeng/restate-effect` binding. The terms are
Restate's own model (we are a faithful binding — see
`decisions/0001-thin-faithful-restate-binding.md`); this glossary fixes the
canonical spelling we use in code and docs.

## Constructs

**Service**:
A stateless Restate handler group with no key and unbounded concurrency. The
default construct.
_Avoid_: "function", "lambda".

**Virtual Object**:
A keyed Restate construct with isolated, durably-persisted **State** and
single-writer-per-key concurrency (exclusive handlers serialized per key; shared
handlers run concurrently, read-only).
_Avoid_: "actor", "entity".

**Workflow**:
A specialized **Virtual Object** with exactly one `run` handler (exactly-once per
**Workflow ID**) plus concurrent signal/query handlers and **Durable Promises**.
_Avoid_: "saga" (a saga is a pattern, not a construct).

**Handler**:
A single invocable method on a Service / Virtual Object / Workflow. Whether it is
*exclusive* or *shared* determines its **Context** capabilities.

## Durable primitives

**Journal**:
The per-invocation append-only record of every durable operation and its result,
used for deterministic **Replay**.

**Replay**:
Re-execution of a handler from the top in a fresh process after a failure or
**Suspension**, skipping already-journaled steps. The determinism contract makes
this safe.

**Durable Step** (`ctx.run`):
A journaled side effect whose result is recorded once and replayed thereafter —
Restate's unit of effectively-once execution. (`@effect/workflow` calls this an
"Activity".)

**Awakeable**:
An external-completion token: a handler suspends on an awakeable ID and an
outside system resolves/rejects it to resume. The external-signal /
human-in-the-loop primitive.

**Durable Promise**:
A named, durable promise on a **Workflow** for cross-handler signalling
(resolve/reject/peek), surviving **Replay**.

**State**:
A **Virtual Object** / **Workflow** keyed K/V store, atomic with the **Journal**.

## Execution semantics

**Terminal Error**:
An error that stops retries, fails the invocation to the caller, and triggers
compensations. Everything else retries. The boundary between Effect's typed error
channel and Restate retry semantics maps onto this distinction.

**Idempotency Key**:
A caller-supplied key that dedupes an invocation across retries/calls.

**Suspension**:
An invocation pausing (holding zero resources) while awaiting a durable
timer/promise/call, later resumed via **Replay**. Not an error.

## Deployment

**Deployment**:
A registered handler endpoint (HTTP URI / Lambda ARN) discovered by the
**restate-server**; immutable and versioned.

**restate-server**:
The single Rust binary that brokers calls, owns the **Journal** and **State**,
and drives **Replay**. Sits between callers and handlers.

**Ingress**:
The external entry point (HTTP, default :8080) for invoking handlers from outside
Restate.
