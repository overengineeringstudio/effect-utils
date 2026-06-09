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
_exclusive_ or _shared_ determines its **Context** capabilities.

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

## Scheduling

**Reschedule** (`Restate.reschedule`):
A typed durable SELF-SEND: a keyed handler re-arms one of its OWN handlers via a
delayed one-way send (read its key from `Restate.key`, send with a `delayMillis`).
The building block for a durable daemon. Journaled → idempotent under **Replay**.
Capability-gated to keyed handlers (`ObjectKey`).
_Avoid_: "self-call" (it is a one-way send, never a blocking call).

**Poll Loop / Scheduled** (`RestateScheduled.make` / `Restate.pollLoop`):
A narrow durable recurring-loop primitive: a **Virtual Object** whose internal
`cycle` handler runs one **Cycle** of the user's work, then re-arms via
**Reschedule**. Owns the schedule, the stop condition, the per-cycle error policy,
overlap prevention (the per-key write lock), and a `start`/`stop`/`status` control
surface. v1 schedules `fixedDelay` only.

**Cycle**:
One bounded iteration of a **Poll Loop** — the user's `cycle` effect for one tick.
Each cycle is a fresh, bounded, COMPLETED invocation (its **Journal** does not grow
with the number of cycles). May end the loop by returning `{ stop: true }`.

**Generation token**:
A monotonic counter on a **Poll Loop**, bumped on every `start`, carried by each
delayed re-arm send; a landing **Cycle** whose generation is stale (or whose status
is not `running`) no-ops. How `stop`/restart invalidate an in-flight delayed timer
WITHOUT a timer handle.

**fixedDelay**:
A **Poll Loop** schedule where the gap between the END of one **Cycle** and the
START of the next is exactly `delayMillis` (never overlaps, never catches up). The
v1 schedule shape; `fixedRate`/`cron` are deferred.

**Retry re-arm** (Retry-After re-arm):
A **Poll Loop** behavior (opt-in via `errorSchema`): a cycle failure that classifies
as `retryable` (via the boundary's `classifyOutcome`) RE-ARMS the next **Cycle** after
the error's projected `retryAfter` floor — the **Generation token** is bumped and a
fresh `retryAfter` send armed so the pre-armed `fixedDelay` send no-ops. The cursor
and iteration are FROZEN: the SAME logical cycle retries, it does not advance.
`maxRetryBackoffs` caps consecutive re-arms before demoting to the **OnCycleError**
policy.
_Avoid_: "cycle retry" (it re-arms the loop, it does not re-run the bounded
`Restate.run`).

**wakeId**:
The id of a **Poll Loop**'s live inter-cycle wake awakeable (wake mode), persisted in
State and exposed via a SHARED `wakeId` handler so an external webhook can read it
(even while an exclusive **Cycle** holds the write lock) and `resolveAwakeable` it to
fire the next cycle EARLY. ROTATED every cycle; a stale id resolves harmlessly.

**wokenBy**:
The one-shot payload (the wake reason) handed to the NEXT **Cycle** when the previous
inter-cycle wait was cut short by a `wakeId` resolution rather than the timer. Lets the
cycle branch on "woke early for X". `undefined` when the timer fired.

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

**In-memory TestContext**:
A FAITHFUL in-memory `RestateContext` (`makeTestContext` / `makeTestContextLayer`,
`./testing`) for SERVER-FREE unit tests of handler logic + **State** transitions —
a real in-memory implementation (Map-backed State, journaled-once `run`,
deterministic clock/random, controllable `sleep`, per-`handlerKind` capability
markers), NOT a stub and NOT a substitute for the **Test Harness**
(durability/**Replay**/single-writer/cross-invocation need the real server). See
`decisions/0013`.
_Avoid_: "mock context".

**withRestateServer**:
A manual-scope holder over `RestateTestHarness.layer` exposing `setup`/`teardown`
(for `beforeAll`/`afterAll`) + a `harness()` accessor — collapses the copy-pasted
scope/ingress boilerplate when a suite holds ONE server across plain `async` tests.

**liveSleep / withLiveClock**:
Test utils (`./testing`) that pin an `Effect.sleep` / sub-program to a LIVE
`Clock`, so wall-clock waits coordinating with the native server elapse in real
time even under `@effect/vitest` `it.effect`'s virtual `TestClock`.

**Boundary observer**:
The per-invocation observability seam (`BoundaryObserver`, a pure core
`(BoundaryInfo) => (BoundaryOutcome) => void`) wired next to the inbound bridge.
`./otel` supplies the impl that AUTO-stamps `restate.service`/`restate.handler`/
`restate.object.key` on the **attempt span** and, on failure, `restate.error.tag`/
`restate.error.class`. Otel-free in the core. See `decisions/0014`.

**Span attribute (identity / error class)**:
The boundary-stamped attributes an operator slices on in Tempo/Grafana —
`restate.{service,handler,object.key}` (identity) and, on a failure,
`restate.error.{tag,class}` (`class` ∈ `terminal`/`retryable`/`cancelled`, read
from the boundary's `classifyOutcome`).

**`Restate.annotateSpan`**:
The USER span-attribute path — a thin otel-free combinator over
`Effect.annotateCurrentSpan` for business attributes (e.g. `dataSourceId`) on the
current Effect span. Attributes are NOT replay-suppressed; use the `span.label`
convention for a single primary label.

**Exactly-once metric emission**:
The replay-aware seam (`emitWhenProcessing(ctx, …)`) gating every auto baseline
metric on `ctx.isProcessing()`, so a journal **Replay**/extra attempt never
re-increments. The auto baseline:
`restate_invocations_total{service,handler,outcome}`, `restate_invocation_duration_ms`,
`restate_attempts_total`, `restate_durable_steps_total`, `restate_awakeable_wait_ms`,
`restate_poll_loop_cycles_total`. See `decisions/0014`.
_Avoid_: "increment in the handler body" (double-counts across attempts).

**Shared meter (MeterProvider)**:
The OTel `MeterProvider` `RestateOtel.layer({ metricReader?/metricExporter? })`
registers SHARING the tracer's `Resource`, binding Effect's `Metric` so the auto
baseline + user metrics export with the same identity as the traces.

**Logger bridge (`ctx.console`)**:
The per-invocation `loggerLayer(ctx)` that replaces Effect's default logger so an
in-handler `Effect.log*` writes to the invocation's replay-aware **`ctx.console`**
(suppressed during **Replay**, level-controlled via `RESTATE_LOGGING`, stamped with
invocation context). On the CORE `.` export, provided alongside the **determinism
layer**. The format is Effect's own `logfmt`; only the sink changes. See
`decisions/0015`.
_Avoid_: "log to console" (the default `globalThis.console` re-emits on replay).

## Security

**Request identity (`identityKeys`)**:
The Restate v1 request-identity PUBLIC keys (ED25519, `publickeyv1_…`) threaded
into the SDK endpoint builder via `EndpointOptions.identityKeys`. When set, the SDK
rejects any inbound request not signed by the matching private key — authenticating
the server → handlers edge (the handler endpoint, :9080). Pure passthrough. See
`decisions/0016`.
_Avoid_: "API key" (that is the INGRESS auth; identity is the server→handlers JWT).

**Ingress API key (secured ingress)**:
The bearer credential for the you → server edge: `RestateIngress.layer({ url, apiKey })`
sends `apiKey` (a `Redacted<string>`, never printed) as `Authorization: Bearer …`.
Required to reach a SECURED / Restate Cloud ingress. `layerConfig` reads it from
`RESTATE_INGRESS_KEY` (a `Config.redacted`). See `decisions/0016`.
_Avoid_: "request identity" (that authenticates the OTHER edge, server→handlers).
