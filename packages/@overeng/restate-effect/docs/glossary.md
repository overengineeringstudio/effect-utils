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
outside system resolves/rejects it to resume. `Awakeable.make` returns a typed
`{ id, promise }` (id branded). Resolution may come from an IN-HANDLER caller or
from INGRESS (`resolveAwakeable` / `rejectAwakeable`). The external-signal /
human-in-the-loop primitive.

**Durable Promise**:
A named, durable promise on a **Workflow** for cross-handler signalling,
surviving **Replay**. Operations: `get` (await), `resolve`, `reject`, and `peek`
(non-blocking read). A `reject` drives a `'rejected'` State observable via a
**query** handler.

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
The external entry point on the **restate-server** (HTTP, default :8080) for
invoking handlers from outside Restate. Distinct from the **Handler Endpoint**:
ingress is callers → server; the handler endpoint is server → handlers.

**Handler Endpoint**:
The HTTP/2 server THIS binding serves (default :9080), which the
**restate-server** discovers and invokes. Not the ingress port (:8080) and not
the admin port (:9070). The binding owns only this port.

## Testing

**Test Harness**:
The Docker-free scoped `Layer` (`./testing`) that boots a native
**restate-server** on ephemeral ports in an isolated base dir, serves the
endpoint, registers the deployment, and exposes the typed ingress client +
`stateOf`. The Effect-native counterpart to `RestateTestEnvironment`.

**alwaysReplay**:
A harness mode that forces **Replay** at every **Suspension**, surfacing
journal-shape divergence (RT0016). A determinism-hunting tool.

**disableRetries**:
A harness mode that surfaces failures immediately instead of retrying, so a test
sees the first failure rather than a retry loop.

**stateOf / StateProxy**:
`stateOf(contract, key)` returns a `StateProxy` with `get`/`getAll`/`set`/`setAll`,
key- and value-typed against the contract's `state` block, for inspecting and
seeding **State** directly over the Admin API in tests.
