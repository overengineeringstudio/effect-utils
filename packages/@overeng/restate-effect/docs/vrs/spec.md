# Spec: restate-effect — architecture index

This is the top-level architecture index for `@overeng/restate-effect`. It builds
on [requirements.md](./requirements.md); terms are in [glossary.md](./glossary.md)
(inherited downward by every subsystem); the hard-to-reverse rationale is in
[.decisions/](./.decisions/), cited by relative path. The per-subsystem `spec.md`
files carry the detailed design; this page holds only Status, Scope, the
top-level Architecture diagram, the subsystem index, and the cross-cutting
Deferred + Open-design-question lists.

## Status

Implemented. The full v1 surface is built and shipping — the core constructs
(`contract`/`implement`/`define`), the per-invocation runtime boundary, the
determinism layer + lints, the error boundary, the typed clients,
self-reschedule, the `./otel` bridge, the `./testing` harness, and the `./admin`
management surface, all covered by the unit + native-server integration suites.
The original POC (commit `61c8d8cf`) proved the core pillars using a combined
`RestateService.make`; decision
[0010](./.decisions/0010-separated-contract-impl.md) superseded that `make` with
the separated `contract` + `implement` that shipped. POC references in the
subsystem specs point at the proving ground; the shipped modules are the source
of truth. The [Deferred](#deferred-designed-for-later) list notes what is
intentionally out of v1.

## Scope

Defines (across the subsystem specs): the contract/implement authoring API for
all three constructs; the per-invocation Effect runtime boundary; the typed
capability-marker context model; the Schema↔Restate serde; the error boundary and
typed ingress decode; the determinism layer (journaled Clock/Random + explicit
durable waits) and lint; deterministic concurrency combinators; replay-aware
logging; cancellation ↔ interruption and the invocation lifecycle; the Schema
annotation namespace; retry surfacing; the endpoint Layer and `serve`; secured
deployments; the ingress (incl. idempotency / attach / output / awakeable
resolution) and in-handler typed clients; self-reschedule + durable scheduling;
the OTel bridge; deployment evolution; the testing harness; and the `./admin`
management surface.

Does not define: the Restate engine semantics themselves (see
[glossary.md](./glossary.md) and Restate's own docs); the deferred features
listed under [Deferred](#deferred-designed-for-later).

## Architecture

```
                         author time                           run time
  ┌───────────────────────────────────────┐     ┌──────────────────────────────────┐
  │ contract(name, { handler: {            │     │  restate-server (Journal, State, │
  │   input, success, error, state? } })   │     │  Replay, retries, timers)        │
  │            │                           │     └───────────────┬──────────────────┘
  │            ├──► typed ingress client   │          h2c protocol│ (discovery + invoke)
  │            └──► in-handler clients      │                     ▼
  │ implement(contract, { handler: eff })  │     ┌──────────────────────────────────┐
  │            │                           │     │ endpoint Layer (scoped h2c serve)│
  │            ▼                           │     │   materialize(impl, runtime)     │
  │     server-side Layer ─────────────────┼────►│     per-invocation boundary:     │
  └───────────────────────────────────────┘     │       decode → provide ctx +     │
                                                 │       capability markers + det.  │
   shared AppLayer (clients, config) ───────────►│       layer → run Effect →       │
   built once → Runtime<R>                       │       encode | toTerminal        │
                                                 └──────────────────────────────────┘
```

Two artifacts per service: a **contract** (shareable, client-side, no server
deps; satisfies R09) and an **implementation** (server-side Layer). The endpoint
materializes implementations against a shared runtime and runs each invocation
through one boundary (R30).

Module layout (subpath exports):

```
.            core: constructs, combinators, serde, error boundary, endpoint, clients, logging
./otel       OpenTelemetry bridge (opt-in deps)          (R03, R23–R25)   SHIPPED
./testing    Docker-free native-server harness Layer     (R26–R28d)       SHIPPED
./admin      management API over the admin REST surface  (decision 0018)  SHIPPED
```

`./otel`, `./testing`, and `./admin` are opt-in subpath exports declared in
`package.json` alongside their modules; the otel/metrics, testing-only, and
admin deps stay scoped to those subpaths so the core `.` surface stays
dependency-light (R03). Logging (§03-effect-runtime) is the exception — it ships
on the core `.` export.

## Subsystem index

The `0N` prefix encodes reading + dependency order (`0N` may depend on lower
numbers, not the reverse); the SAME taxonomy drives the `src/` subdirs, so code
and docs mirror each other. Each subsystem `spec.md` opens with a link up to
[../requirements.md](./requirements.md) + its own `requirements.md`.

| #   | Subsystem                                       | Spec covers                                                                                                                                               | Requirements                                | Decisions                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | [authoring](./01-authoring/spec.md)             | contract/implement/define, construct selection, capability-marker context, per-invocation runtime boundary, invocation lifecycle, service/handler options | R04, R05, R06, R09, R30, R34, R35, R36      | [0002](./.decisions/0002-typed-capability-contexts.md), [0008](./.decisions/0008-typed-client-inference.md), [0010](./.decisions/0010-separated-contract-impl.md)                                                                                                           |
| 02  | [schema-serde](./02-schema-serde/spec.md)       | Effect Schema ↔ Restate serde, JSON wire + discovery, slot-aware failure, the Schema annotation namespace, field redaction                                | R07, R08                                    | [0011](./.decisions/0011-restate-schema-annotations.md), [0020](./.decisions/0020-contract-invocation-policy.md)                                                                                                                                                            |
| 03  | [effect-runtime](./03-effect-runtime/spec.md)   | determinism layer (Clock/Random + frozen base + explicit durable waits), deterministic concurrency, nondeterminism/durability lints, replay-aware logging | R17, R18, R19, R20, R37                     | [0004](./.decisions/0004-determinism-layer.md), [0005](./.decisions/0005-deterministic-concurrency.md), [0015](./.decisions/0015-logger-ctx-console-bridge.md)                                                                                                              |
| 04  | [error-boundary](./04-error-boundary/spec.md)   | error boundary + `toTerminal`, cancellation ↔ interruption, retry surfacing, saga/compensation                                                            | R11, R12, R13, R14, R15, R16, R21, R22, R31 | [0003](./.decisions/0003-error-boundary-model.md), [0006](./.decisions/0006-restate-owns-retries.md)                                                                                                                                                                        |
| 05  | [clients](./05-clients/spec.md)                 | external ingress client (idempotency/attach/output/awakeable), in-handler service-to-service clients, the contract-invocation policy                      | R10, R32, R33                               | [0008](./.decisions/0008-typed-client-inference.md), [0020](./.decisions/0020-contract-invocation-policy.md)                                                                                                                                                                |
| 06  | [scheduling](./06-scheduling/spec.md)           | self-reschedule, durable scheduling (`pollLoop`), composition/wake                                                                                        | —                                           | [0012](./.decisions/0012-self-reschedule.md)                                                                                                                                                                                                                                |
| 07  | [endpoint-deploy](./07-endpoint-deploy/spec.md) | endpoint scoped Layer + `serve`, securing the endpoint + env-driven config, deployment evolution                                                          | R29, R38, R39                               | [0016](./.decisions/0016-secured-ingress-and-request-identity.md)                                                                                                                                                                                                           |
| 08  | [observability](./08-observability/spec.md)     | OpenTelemetry bridge, span attributes (identity + error class), metrics path                                                                              | R23, R23b, R24, R25                         | [0007](./.decisions/0007-otel-bridge.md), [0014](./.decisions/0014-observability-metrics-and-attrs.md)                                                                                                                                                                      |
| 09  | [testing](./09-testing/spec.md)                 | native-server harness, typed State inspect/seed, determinism-hunting modes, in-memory `TestContext`, swappable `RestateTestEnv`                           | R26, R26a–d, R27, R28                       | [0009](./.decisions/0009-effect-native-testing-harness.md), [0013](./.decisions/0013-in-memory-test-context.md), [0017](./.decisions/0017-swappable-test-env.md), [0019](./.decisions/0019-shared-ssot-helpers.md), [0020](./.decisions/0020-contract-invocation-policy.md) |
| 10  | [admin](./10-admin/spec.md)                     | operations / management API over the admin REST surface, the Molty runbook                                                                                | —                                           | [0018](./.decisions/0018-admin-management-api.md)                                                                                                                                                                                                                           |

---

## Deferred (designed for later)

Out of v1 scope, designed to slot in without reshaping the core. Each is tracked
as a follow-up issue:

- **Serverless targets** — Lambda / fetch / Cloudflare Workers endpoints
  (`createEndpointHandler` over the SDK's `/lambda` and `/fetch` subpaths, with a
  module-scope runtime and `dispose()` in the platform shutdown hook). v1 is
  node-h2c only (A08).
- **First-class saga helper** — a `withCompensation` combinator over the
  [04-error-boundary](./04-error-boundary/spec.md#saga--compensation-future)
  mechanism. The cancel↔interrupt mapping it relies on is NOT deferred (it ships
  in v1, [04-error-boundary](./04-error-boundary/spec.md#cancellation--interruption));
  only the packaged register-and-unwind helper is.
- **Typed-failure-transport `Restate.run`** — a `run` variant that HONORS a typed
  durable-step failure by journaling an encoded `fail(E)` via an error schema (so a
  typed inner failure round-trips through the journal and reaches the outer `E`
  channel), instead of the v1 contract where a durable step has NO catchable typed
  failure (`Effect<A, never, R>`; domain errors live in the handler body / encoded
  values, infra/give-up are `RestateError` defects — see
  [04-error-boundary](./04-error-boundary/spec.md#error-boundary),
  [.decisions/0003](./.decisions/0003-error-boundary-model.md) #4). Deferred: it needs
  a journal-serde'able failure encoding and a boundary-classification story that does
  not regress the clean-`E` invariant.
- **Scheduling / cron sugar** — typed wrappers over delayed `send` +
  self-reschedule, plus `fixedRate` / `cron` schedules (v1 ships `fixedDelay`
  only, see [06-scheduling](./06-scheduling/spec.md)).
- **`JournalValueCodec`** — the experimental endpoint-global WHOLE-VALUE byte
  layer below serde (compression / whole-value encryption). FIELD redaction is NOT
  part of this — that is a serde Schema transform (see
  [02-schema-serde](./02-schema-serde/spec.md),
  [.decisions/0011](./.decisions/0011-restate-schema-annotations.md)) and ships in
  v1; the codec stays fully deferred.
- **Stream follow story** — surfacing a Restate invocation's incremental output /
  log tail as an Effect `Stream` (e.g. follow a long-running Workflow). v1 exposes
  only the request/response + attach/output surfaces
  ([05-clients](./05-clients/spec.md)).
- **Generic / untyped in-handler call** — a public escape hatch over the SDK's
  `ctx.genericCall` for calling a service NOT described by an imported contract
  (cross-language / dynamic targets). v1's in-handler clients are contract-typed
  only ([05-clients](./05-clients/spec.md),
  [.decisions/0008](./.decisions/0008-typed-client-inference.md)); `genericCall` is
  used internally but not exposed untyped.
- **Batch admin operations** — the BULK/BATCH invocation verbs (a filtered
  `PATCH /invocations/{verb}`) do NOT exist on restate-server 1.6.2 (they 405) and
  are a later-server feature; `./admin` does not offer them on a server that lacks
  them. Deferred until a newer server is the floor (see
  [10-admin](./10-admin/spec.md),
  [.decisions/0018](./.decisions/0018-admin-management-api.md)).
- **Multi-deployment suspend-straddle replay** — a FULL cross-version replay where
  an invocation STARTED on V1 SUSPENDS mid-handler and RESUMES its journal on V2
  after the upgrade. The registration + routing-to-latest half is proven; a
  controllable mid-invocation suspension straddling the re-register is the residual
  follow-up (see
  [09-testing](./09-testing/spec.md#determinism-hunting-modes--lifecycle-contract),
  [07-endpoint-deploy](./07-endpoint-deploy/spec.md#3-deployment-evolution)).
- **Cosmetic Effect polish** — internal-only refactors that do not change behavior
  or surface: `Match` over hand-rolled tag switches, `Effect.fn` for named spans,
  `Schema.Equivalence` where value-equality is hand-derived, and `Effect.Service`
  for the remaining `Context.Tag` + `Layer` service pairs.

## Open design questions

A three-stream empirical de-risk (type-level prototypes vs real `effect` +
`restate-sdk`; SDK ground truth from the published `.d.ts`/source; native
restate-server 1.6.2, no Docker), followed by the shipped implementation,
resolved every DQ below. No residual genuine-unknown design questions remain;
DQ1 is the one entry kept open as a perf note (not a design fork). Each DQ is
owned by the subsystem that resolved it; cross-links into the subsystem specs are
given.

- **DQ1 Durable-wait overhead (reframed):** With durable waits now explicit (R18,
  T02 — no transparent remap), the original "non-durable escape hatch" question is
  RESOLVED: a bare `Effect.sleep` is the non-durable path and `Restate.sleep` the
  durable one. The residual question is only whether `Restate.sleep` overhead
  matters for very short durable waits — a perf note, not a design fork. (See
  [03-effect-runtime](./03-effect-runtime/spec.md),
  [.decisions/0004](./.decisions/0004-determinism-layer.md).)
- **DQ2 Pure-vs-durable concurrency guard — RESOLVED.** The descriptor type shape
  rejects an arbitrary `Effect[]` and recovers a precise tuple/union, confirmed
  against the real `RestatePromise.all`/`race`/`any` signatures (`readonly
RestatePromise<unknown>[]`, leaf/descriptor model) and the `.then`-is-suspension
  /`.map`-the-result invariant. The typed descriptor is the primary guard; the lint
  rule against a fan-out handler stays the advisory backstop (see
  [03-effect-runtime](./03-effect-runtime/spec.md)).
- **DQ3 Capability-marker discharge over a mixed record — RESOLVED.** Discharging
  markers per handler kind over a HETEROGENEOUS `implement` record (exclusive +
  shared in one call) COMPILES against real `effect` + `restate-sdk` types and
  yields a handler-LOCAL error (a `State.set` in a shared handler; not a
  whole-record error, not erased to `any`), with per-kind `provideService`
  collapsing each handler's residual `R` to the app `R`. Flat markers are kept; the
  distinct-context-Tags fallback compiles but is strictly worse and is not needed.
  Requires the explicit-app-`R` discipline (see
  [01-authoring](./01-authoring/spec.md),
  [.decisions/0002](./.decisions/0002-typed-capability-contexts.md)).
- **DQ4 Contract → client inference — RESOLVED.** The phantom `Contract<Name,
HandlerMap>` + `const` type params + `InputOf`/`SuccessOf`/`ErrorOf` indexed
  accessors recover the EXACT per-handler types (proven with `Equals<>`) without
  erasing to `Record<string, …>`; wrong-input / unknown-method / wrong-success all
  error. The Phase-1 gate (paired with DQ3) passes. (See
  [05-clients](./05-clients/spec.md),
  [.decisions/0008](./.decisions/0008-typed-client-inference.md).)
- **DQ5 Native-server replay/retry modes — RESOLVED.** Both are server-global env
  vars on native restate-server 1.6.2 (verified via `--dump-config` + replay
  re-entry; see [09-testing](./09-testing/spec.md)): `alwaysReplay` =
  `RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s`; `disableRetries` =
  `RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=1` +
  `RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=kill`. (See
  [.decisions/0009](./.decisions/0009-effect-native-testing-harness.md).)
- **DQ6 Frozen monotonic base — RESOLVED.** Confirmed in implementation:
  `determinismLayer` seeds a per-attempt frozen sync base from the first
  `ctx.date.now()`, and `src/runtime/Runtime.test.ts` asserts `Clock.unsafeCurrentTime*` is
  FROZEN at entry (does not advance mid-attempt) while the async
  `Clock.currentTimeMillis` tracks `ctx.date`. Determinism is also validated
  end-to-end against native restate-server 1.6.2 — a `Restate.run` side effect
  fires exactly once across replays and journaled reads are replay-stable (the
  `alwaysReplay determinism` lane in `src/endpoint/examples.integration.test.ts`, see
  [03-effect-runtime](./03-effect-runtime/spec.md)). (See
  [.decisions/0004](./.decisions/0004-determinism-layer.md).)
- **DQ7 h2c prior-knowledge handshake — RESOLVED.** `http2.createServer(
createEndpointHandler({ services }))` with `bidirectional` UNSET serves h2c
  prior-knowledge correctly against native restate-server 1.6.2 discovery: full
  `BIDI_STREAM` is negotiated and a real `ctx.sleep` suspend → persist → resume
  worked over h2c (no TLS/ALPN). `true` is redundant; `false` degrades to
  request/response — the binding leaves it unset (see
  [07-endpoint-deploy](./07-endpoint-deploy/spec.md)).
