# Spec: 09-testing

Specifies the Docker-free testing harness (`./testing`): the native-server scoped
Layer, typed State inspect/seed, determinism-hunting modes, test layering, the
in-memory `TestContext`, and the swappable `RestateTestEnv` façade. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R26, R26a–d, R27, R28. See
[../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md),
[../.decisions/0013](../.decisions/0013-in-memory-test-context.md),
[../.decisions/0017](../.decisions/0017-swappable-test-env.md) (the swappable
`RestateTestEnv` façade), and
[../.decisions/0019](../.decisions/0019-shared-ssot-helpers.md) (the shared
`freePort` SSOT). POC reference: `test/restate-server.ts`. `./testing` is a
shipped opt-in subpath export (`src/testing.ts`).

A scoped `Layer` that, on acquire, boots a native `restate-server` (no Docker) on
ephemeral ports against an isolated temp base dir, waits for the admin health
endpoint, builds and serves the endpoint, and registers the deployment; on
release it shuts the server down and removes the base dir.

```ts
it.effect('greet round-trips', () =>
  Effect.gen(function* () {
    const harness = yield* RestateTestHarness // scoped Layer
    const result = yield* harness.ingress.call(Greeter, 'greet', { name: 'Sarah' })
    expect(result.message).toBe('Hello Sarah')
    const status = yield* harness.stateOf(Onboard, 'wf-1').get('status') // typed State
  }).pipe(
    Effect.provide(RestateTestHarness.layer({ services: [GreeterLive], appLayer: AppLayer })),
  ),
)
```

## 1. Typed State inspect/seed (R26b)

`harness.stateOf(contract, key)` returns a typed proxy with
`get` / `getAll` / `set` / `setAll`, key- AND value-typed against the contract's
`state` block, serialized via `effectSerde` and driven over the Admin API. This
is stable public API (mirrors the testcontainers `StateProxy`, but typed against
the contract instead of a free `TState` generic). Used to seed pre-conditions and
assert post-conditions without going through a handler.

## 2. Determinism-hunting modes + lifecycle contract (R26a, R27)

Two typed options mirror `RestateTestEnvironment`, the primary tools for catching
RT0016:

- `alwaysReplay` — force replay at every suspension (surfaces journal-shape
  divergence T07 introduces).
- `disableRetries` — surface failures immediately instead of retrying.

These MUST be consumer-available. RESOLVED (DQ5) against native restate-server
1.6.2 — both are server-global env vars (verified via `--dump-config` + a handler
re-entering under replay; lifted from `@restatedev/restate-sdk-testcontainers`):

| Mode             | Env vars                                                                                              | Config-file keys                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `alwaysReplay`   | `RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s`                                                      | `[worker.invoker] inactivity-timeout`                     |
| `disableRetries` | `RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=1` + `RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=kill` | `[default-retry-policy] max-attempts` / `on-max-attempts` |

The harness also supports MULTI-deployment registration via
`harness.registerDeployment({ services, appLayer })` (section 6), so a test can
register two endpoint VERSIONS on separate ephemeral ports and assert the upgrade —
two deployments coexist on the admin API and a new invocation routes to the latest
(T07, A11). RESIDUAL (follow-up): a FULL cross-version replay where an invocation
started on V1 SUSPENDS mid-handler and RESUMES its journal on V2 needs a
controllable mid-invocation suspension straddling the re-register — deferred; the
registration + routing-to-latest half is proven.

Lifecycle contract (R27, sharpened over the POC):

- EPHEMERAL ports for ALL listeners — server ingress, admin, AND the SDK handler
  endpoint — via OS port-0, never fixed (the POC's 8080/9070/9080 are
  disallowed). The native server's ingress/admin bind addresses are set per
  instance via `RESTATE_INGRESS__BIND_ADDRESS` / `RESTATE_ADMIN__BIND_ADDRESS`
  (verified), the harness-isolation mechanism behind R27. An isolated temp base
  dir per instance. Port allocation goes through the shared `@overeng/utils/node`
  `freePort`/`freePorts` SSOT, and the native-server boot is RETRIED on a port
  collision (`Address in use` / `EADDRINUSE`) with a fresh `freePorts(3)` batch —
  closing the bind-release-rebind TOCTOU under parallel boots
  ([../.decisions/0019](../.decisions/0019-shared-ssot-helpers.md)).
- Startup: poll a defined health target with a defined timeout; on failure, dump
  the buffered server output as diagnostics (promote the POC's buffer-on-failure
  behavior into the contract).
- Finalizer ordering, all in ONE scope: close the SDK endpoint → SIGTERM then
  SIGKILL the server → remove the base dir.

## 3. Test layering (R26c)

The two CORE guarantees are server-free testable; only true end-to-end paths need
the integration job:

| Layer       | Needs server?       | Covers                                                                                                                                                                                                           |
| ----------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | no                  | serde round-trips, `toTerminal`, pure combinators, annotation read-back; AND server-free handler-logic / State-transition tests via the in-memory `TestContext` (section 5) OR `RestateTestEnv.mock` (section 6) |
| contract    | no                  | error-transport round-trip (decode helper over a constructed `TerminalError`); OTel exactly-once via an in-memory `SpanExporter`                                                                                 |
| integration | yes (native server) | real invoke/replay, State, awakeables, durable promises, single-writer, cross-invocation (calls/sends/`reschedule`/`pollLoop`), journal-shape (`alwaysReplay`)                                                   |

The in-memory `TestContext` (section 5) extends the `unit` row to handler LOGIC: a
handler's control flow + State read-modify-write is testable server-free. The
`RestateTestEnv.mock` backend (section 6) PROMOTES that same unit-level coverage to
the CONTRACT-ADDRESSED surface (`invoke(contract, …)`, not `impl.method(…)`), so the
same test body runs unchanged on the real server via `RestateTestEnv.real`. Anything
durability-, replay-, single-writer-, or cross-invocation-shaped stays in the
`integration` row (only the real server provides it).

## 4. Consumer workflow (R26d)

A consumer imports `./testing`; the harness `Layer` ACCEPTS the consumer's
`AppLayer` (so handler `R` is satisfied inside the spawned endpoint) and exposes
the typed ingress client + `stateOf`; tests use `@effect/vitest` `it.effect`.

Property-based testing is first-class AND IMPLEMENTED for serde: `@effect/vitest`
`it.prop` derives a `fast-check` `Arbitrary` from each schema and asserts
`deserialize(serialize(x))` is EQUIVALENT to `x` — using `Schema.equivalence(schema)`
(NOT `toStrictEqual`), so transformed/branded values compare by their decoded VALUE.
Covered: a plain struct, a transformed schema (encoded ≠ decoded), an optional state
field (the `normalizeStateSchema` path), and CRITICALLY the redaction transform
(`encrypt(decrypt(x)) ≡ x` by value, since a fresh IV per encrypt makes the bytes
differ each time). Values outside the JSON-representable domain (`NaN`/`±Infinity`,
which `JSON.stringify` emits as `null`) are excluded via `Schema.Finite` — they are
not round-trippable by design, not a serde bug (`src/Serde.test.ts`). Deterministic-
replay property tests (run a handler, replay it under `alwaysReplay`, assert
identical journal/result) remain integration-lane.

Awakeable / durable-promise example: seed State via `stateOf` → `submit` a
workflow → `resolveAwakeable` via ingress → `attach` and assert completion.

CI (R28, sharpened): a dedicated, SERIALIZED integration job mirroring the
existing `test-integration-notion` lane
(`nix/devenv-modules/tasks/local/notion-integration-test.nix` + the genie job).
`restate-server` from `nix/restate.nix` is on `$PATH` via `RESTATE_SERVER_BIN`,
with `allowUnfreePredicate` scoped to `restate`; generous timeout; graceful SKIP
when the binary is absent. Open question: whether `alwaysReplay` runs in the
default lane or a scheduled lane (server-spawn cost tradeoff). The harness is
public API and must stay stable.

## 5. In-memory `TestContext` + ergonomics (decision 0013)

A FAITHFUL in-memory `RestateContext` for SERVER-FREE unit tests of handler logic

- State transitions — a real in-memory implementation, NOT a stub. `./testing`
  exports `makeTestContext(options)` (returns the fake `restate.ObjectContext` + the
  backing State `Map` + the `run`-memoization journal) and `makeTestContextLayer(options)`
  (a `Layer` providing `RestateContext` + the capability markers for the chosen
  `handlerKind`). Provide the layer over the real handler effect and assert on the
  result AND the State `Map`:

```ts
const state = new Map<string, unknown>([['count', 40]])
const next =
  yield *
  CounterLive.impl.add(3).pipe(Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })))
// next === 43; state.get('count') === 43
```

FAITHFULLY modeled: State (`get`/`set`/`clear`/`clearAll`/`stateKeys`) over a real
`Map`, round-tripped through the same `effectSerde`; `ctx.run(name, …)` executes
once and MEMOIZES by name (journaled-once: a re-`run` returns the stored value);
deterministic `ctx.date`/`ctx.rand` (seeded); a controllable no-op `ctx.sleep`;
`ctx.key`; the per-`handlerKind` capability gating (the SAME marker subset
`Endpoint.materialize*` provides, so a `State.set` in a read-only handler is still
a compile error); in-handler awakeable resolve/await. NOT modeled (use the real
harness): durability / replay / suspension, single-writer / per-key concurrency,
and cross-handler / cross-invocation effects (`call`/`send`/`reschedule`/
delayed-self-send/`pollLoop`/cross-invocation durable-promise resolution).
Explicitly documented (module JSDoc + README + decision 0013) as NOT a substitute
for `RestateTestHarness`.

`withRestateServer({ services, appLayer })` is a manual-scope harness holder over
`RestateTestHarness.layer`: it collapses the copy-pasted ~25-line
`beforeAll`/`afterAll` (make a `Scope`, build the harness layer into it, extract
the service, close the scope) into `setup`/`teardown` + a `harness()` accessor. A
suite wires `beforeAll(held.setup)` / `afterAll(held.teardown)` and reads
`held.harness().ingress.*` / `.stateOf(...)`. Prefer `@effect/vitest` `it.layer`
for `it.effect` suites; use `withRestateServer` when the suite drives the ingress
from plain `async` bodies and needs ONE server held across all tests.

Live-clock test util (the `@effect/vitest` `it.effect` virtual-`TestClock`
friction): under `it.effect` a bare `Effect.sleep` is virtual and never advances,
so a real-time wait coordinating with the native server across suspend/resume
HANGS. `./testing` surfaces `liveSleep(millis)` (an `Effect.sleep` pinned to a live
`Clock.make()`) and `withLiveClock(effect)` (run a sub-program under a live clock),
so wall-clock waits elapse regardless of the ambient test clock.

## 6. Swappable `RestateTestEnv` façade (decision 0017)

`RestateTestEnv` is ONE `Context.Tag` whose surface is the CONTRACT-ADDRESSED
invocation level — `invokeService(contract, method, input)` /
`invokeObject(contract, key, method, input)` /
`submitWorkflow` / `signalWorkflow` / `attachWorkflow` / `stateOf` (the same typed
`StateProxy`) / `resolveAwakeable` / `kind: 'mock' | 'real'` — with TWO Layer impls
satisfying the same Tag, so the SAME test body runs on either backend:

- `RestateTestEnv.mock({ services, appLayer })` — in-process dispatch over per-key
  `Map`s and a shared awakeable registry, NO journal, NO server (ms).
- `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` — a
  thin wrapper over `RestateTestHarness.layer` (decision 0009).

It is the swappable façade OVER the two existing primitives (`makeTestContextLayer`
and `RestateTestHarness` stay available — additive). The LOAD-BEARING property:
`invoke*` carries `RestateError | ErrorOf` (the TYPED declared error) on BOTH
backends, so `catchTag(DomainError)` compiles AND recovers identically on the mock
and the real server. The mock recovers the typed `E` by round-tripping the failure
through the contract's `error` schema (the SAME decode an ingress caller performs).
This also made the bound harness ingress's typed form the default invoke (the
precise typed-error union no longer widens — the old escape to the standalone
`callTyped` is gone).

The mock reuses the package's real building blocks (not a re-implementation): the
captured `Runtime<AppR>`, the in-memory `makeTestContext`, the shared
`Endpoint.provideHandlerCaps` per-kind marker provision (the single source of truth,
also used by the real `materialize*` boundary), the journaled `determinismLayer`,
and `classifyOutcome`. Mock-vs-real matrix (mock models: handler logic, typed
success+error, typed State + per-key isolation, `Restate.run` journaled-once within
an invoke, deterministic time/rand/sleep, awakeable resolve/await; real-only:
durability/replay/suspension, exactly-once-across-attempts/retry,
single-writer/concurrency, cross-invocation, admin-cancel, idempotency-keyed result
attach, OTel reparenting). Parametrize with `it.each(['mock', 'real'])` and gate the
real backend with `kind === 'real' && !serverAvailable`.

`RestateTestHarness.registerDeployment({ services, appLayer })` serves an ADDITIONAL
endpoint version on a fresh ephemeral port and registers it as a SECOND deployment
(the multi-deployment machinery promised in section 2): two versions coexist on the
admin API and a new invocation routes to the latest (the upgrade). The harness
`layer` also accepts endpoint observability wiring (`hooks` / `inboundBridge` /
`boundaryObserver`) so OTel reparenting + exactly-once metrics are exercisable
against the real server under `alwaysReplay`.
