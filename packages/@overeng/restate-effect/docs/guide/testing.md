# Testing (`./testing`)

[← Handbook index](./README.md)

The `./testing` subpath exports three test surfaces:

- a **swappable `RestateTestEnv`** façade — ONE contract-addressed body that runs on
  either a fast in-process **mock** or the real server;
- a **native-server harness** (no Docker) for true end-to-end paths;
- a **faithful in-memory `TestContext`** for fast, server-free handler-logic tests.

`RestateTestEnv` is the front door (write the body once, swap the backend);
`RestateTestHarness` + `makeTestContextLayer` are the lower-level primitives it
composes over (both still available).

## Test layering

The two core guarantees are server-free testable; only true end-to-end paths need
the integration job.

| Layer       | Needs server?       | Covers                                                                                                                                                                        |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | no                  | serde round-trips, `toTerminal`, pure combinators, annotation read-back; AND server-free handler-logic / State tests via the in-memory `TestContext` OR `RestateTestEnv.mock` |
| contract    | no                  | error-transport round-trip (decode over a constructed `TerminalError`); OTel exactly-once via an in-memory `SpanExporter`                                                     |
| integration | yes (native server) | real invoke/replay, State, awakeables, durable promises, single-writer, cross-invocation (calls/sends/`reschedule`/`pollLoop`), journal-shape (`alwaysReplay`)                |

## Swappable `RestateTestEnv` (one body, two backends)

`RestateTestEnv` is ONE `Context.Tag` whose surface is the CONTRACT-ADDRESSED
invocation level — `invokeService(contract, method, input)` /
`invokeObject(contract, key, method, input)` / `submitWorkflow` / `signalWorkflow` /
`attachWorkflow` / `stateOf` / `resolveAwakeable` / `kind` — with TWO Layer impls, so
the SAME body runs on either backend:

- `RestateTestEnv.mock({ services, appLayer })` — in-process, no server, in ms.
- `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` — a
  thin wrapper over `RestateTestHarness`.

The key property: `invoke*` carries `RestateError | ErrorOf` (the TYPED declared
error) on BOTH backends, so `catchTag(DomainError)` compiles AND recovers identically
on the mock and the real server. Parametrize with `it.each(['mock', 'real'])` and gate
the real backend with `kind === 'real' && !serverAvailable`. Verified by
[`src/test-env.integration.test.ts`](../../src/testing/test-env.integration.test.ts).

```ts
import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { describe, expect } from 'vitest'
import { RestateTestEnv, serverAvailable } from '@overeng/restate-effect/testing'

const backends = [
  { kind: 'mock' as const, layer: () => RestateTestEnv.mock({ services, appLayer }) },
  { kind: 'real' as const, layer: () => RestateTestEnv.real({ services, appLayer }) },
]

describe.each(backends)('RestateTestEnv ($kind)', ({ kind, layer }) => {
  const d = kind === 'real' && !serverAvailable ? describe.skip : describe
  d(kind, () => {
    it.layer(layer(), { timeout: 90_000 })('same body', (it) => {
      it.effect('typed success + typed error + State', () =>
        Effect.gen(function* () {
          const env = yield* RestateTestEnv
          const ok = yield* env.invokeService(Greeter, 'greet', { name: 'Sarah' })
          expect(ok.message).toBe('Hello Sarah')

          // typed error recovers IDENTICALLY on mock and real
          const recovered = yield* env
            .invokeService(Greeter, 'greet', { name: '' })
            .pipe(Effect.catchTag('EmptyName', () => Effect.succeed('recovered' as const)))
          expect(recovered).toBe('recovered')

          // typed State seed/assert + per-key isolation, same on both backends
          yield* env.stateOf(CounterObj, 'a').set('count', 40)
          expect(yield* env.invokeObject(CounterObj, 'a', 'add', 2)).toBe(42)
        }),
      )
    })
  })
})
```

### Mock-vs-real matrix

The mock reuses the package's real building blocks (the captured runtime, the
in-memory `ctx`, the per-kind capability provision, the determinism layer, and the
boundary's `classifyOutcome`) — it is faithful to the combinator semantics it covers,
not a stub. But it has NO journal/server, so it does not model the durable runtime:

| Behavior                                       | mock | real |
| ---------------------------------------------- | :--: | :--: |
| handler logic, typed success + typed error     |  ✓   |  ✓   |
| typed State + per-key isolation                |  ✓   |  ✓   |
| `Restate.run` journaled-once WITHIN an invoke  |  ✓   |  ✓   |
| deterministic date / rand / sleep              |  ✓   |  ✓   |
| awakeable resolve / await                      |  ✓   |  ✓   |
| durability / replay / suspension               |      |  ✓   |
| exactly-once across attempts / retry           |      |  ✓   |
| single-writer / concurrency                    |      |  ✓   |
| cross-invocation call/send/reschedule/pollLoop |      |  ✓   |
| admin-cancel, idempotency-keyed result attach  |      |  ✓   |
| OTel attempt-span reparenting under replay     |      |  ✓   |

Author any real-only behavior directly against `.real` (or a dedicated
`*.integration.test.ts`). A green mock test is NOT durability/replay coverage.

## The native-server harness

`RestateTestHarness.layer({ services, appLayer })` is one scoped Layer that boots a
native `restate-server` (no Docker) on ephemeral ports against an isolated temp dir,
serves your endpoint with `appLayer` threaded into the served runtime, registers the
deployment, and exposes a typed ingress client + typed `stateOf` State inspection.
On release it shuts the server down and removes the temp dir. The full file is
[`examples/11-testing.ts`](../../examples/11-testing.ts); the `it.effect` assertions
live in [`src/examples.integration.test.ts`](../../src/endpoint/examples.integration.test.ts).

```ts
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { RestateTestHarness, serverAvailable } from '@overeng/restate-effect/testing'

const Harness = RestateTestHarness.layer({
  services: [GreeterLive, CounterLive],
  appLayer: Greeting.Default,
  disableRetries: true, // surface failures immediately instead of retrying
})

describe.skipIf(!serverAvailable)('greeter', () => {
  it.layer(Harness, { timeout: 90_000 })('round-trips', (it) => {
    it.effect('greets', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const ok = yield* harness.ingress.callTyped(Greeter, 'greet', { name: 'Sarah' })
        expect(ok.message).toBe('Hello Sarah')

        // typed State inspection: seed a pre-condition, assert a post-condition
        yield* harness.stateOf(CounterObj, 'cart-1').set('count', 40)
        const bumped = yield* harness.ingress.objectCall(CounterObj, 'cart-1', 'add', 1)
        expect(bumped).toBe(41)
      }),
    )
  })
})
```

- **`harness.ingress.*`** — the typed ingress client, pre-bound to the spawned
  server (you never thread `RestateIngress`).
- **`harness.stateOf(contract, key)`** — a typed State proxy (`get` / `getAll` /
  `set` / `setAll`), key- and value-typed against the contract's `state` block, over
  the Admin API. Seed pre-conditions and assert post-conditions without invoking a
  handler.
- **`serverAvailable`** lets a suite gracefully `skipIf` when no native binary is on
  `$PATH` (outside the integration job).

### Determinism-hunting flags

Two flags mirror the SDK test environment:

- `alwaysReplay: true` forces a replay at every suspension (surfaces journal-shape
  divergence — the classic replay bug).
- `disableRetries: true` surfaces failures immediately instead of retrying.

`harness.registerDeployment({ services, appLayer })` serves an additional endpoint
VERSION on a fresh ephemeral port and registers it as a second deployment, so a test
can assert the upgrade (two deployments coexist; a new invocation routes to the
latest). The `layer` also accepts endpoint observability wiring (`hooks` /
`inboundBridge` / `boundaryObserver`) — pass the `./otel`
`RestateOtel.{hook,inboundBridge,boundaryObserver}` to exercise OTel reparenting +
exactly-once metrics against the real server (e.g. under `alwaysReplay`).

## In-memory `TestContext` (server-free unit tests)

For fast unit tests of a handler's LOGIC and State transitions — no server, no
Docker — `./testing` also exports a FAITHFUL in-memory `RestateContext`. It is a real
in-memory implementation, not a stub: State is a real `Map` (round-tripped through
the same serde the handler uses), `Restate.run(name, …)` executes once and memoizes
by name (journaled-once), `ctx.date`/`ctx.rand` are deterministic (seeded), and
`ctx.sleep` is a controllable no-op. Verified by
[`src/TestContext.test.ts`](../../src/testing/TestContext.test.ts).

```ts
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeTestContextLayer } from '@overeng/restate-effect/testing'
import { CounterLive } from './counter.ts' // your RestateObject.implement(...)

describe('counter handler logic', () => {
  it('add reads + writes State (server-free)', () =>
    Effect.gen(function* () {
      // seed a pre-condition in the backing State Map
      const state = new Map<string, unknown>([['count', 40]])
      // run the REAL `add` handler against the in-memory context
      const next = yield* CounterLive.impl
        .add(3)
        .pipe(Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })))
      // assert the result AND the State transition
      expect(next).toBe(43)
      expect(state.get('count')).toBe(43)
    }).pipe(Effect.runPromise))
})
```

`makeTestContextLayer(options)` takes ONE options bag (all fields optional):

| Option        | Default             | Purpose                                                                                                                                                                                                                                        |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`       | fresh empty `Map`   | the backing State `Map` (key → serde-encoded value) — seed pre-conditions, read it back to assert transitions                                                                                                                                  |
| `key`         | `'test-key'`        | the Object/Workflow invocation key (`Restate.key` / the `ObjectKey` capability)                                                                                                                                                                |
| `handlerKind` | `'objectExclusive'` | selects the provided capability-marker subset (`service` / `objectShared` / `objectExclusive` / `workflowShared` / `workflowRun`) — the SAME subset the real boundary grants, so a `State.set` in a read-only handler is still a compile error |

(Additional knobs — `nowMillis` / `clockStepMillis` / `randomSeed` / `onSleep` —
control the deterministic clock / PRNG / `ctx.sleep`.) `makeTestContext(options)` is
the lower-level form (returns the fake `ctx` + the State `Map` + the `run` journal).

### What the in-memory context does NOT model

**This is NOT a substitute for `RestateTestHarness`.** It deliberately does not
model:

- durability / replay / suspension;
- single-writer / per-key concurrency;
- cross-handler / cross-invocation effects (`Restate.call` / `send` / `reschedule` /
  delayed self-send / `pollLoop`, durable promises resolved by another invocation) —
  none of those route anywhere without a server.

Use the harness for any of those; use the in-memory context for fast handler-logic
and State-transition tests.

## Test ergonomics

`withRestateServer({ services, appLayer })` collapses the manual `beforeAll`/`afterAll`
scope/ingress boilerplate into `setup`/`teardown` + a `harness()` accessor — for a
suite that holds ONE native server across plain `async` test bodies (prefer
`@effect/vitest`'s `it.layer` for `it.effect` suites):

```ts
const held = withRestateServer({ services: [CounterLive], appLayer: Layer.empty })
beforeAll(held.setup, 90_000)
afterAll(held.teardown, 90_000)
// ... in a test:
const result = await Effect.runPromise(held.harness().ingress.objectCall(CounterObj, 'k', 'add', 1))
```

### Live-clock utilities

Under `@effect/vitest`'s `it.effect`, a bare `Effect.sleep` runs on a virtual
`TestClock` and never advances — a real-time wait coordinating with the native server
across suspend/resume would hang. `./testing` exports `liveSleep(millis)` (an
`Effect.sleep` pinned to a live `Clock`) and `withLiveClock(effect)` so wall-clock
waits actually elapse.

## See also

- [Determinism](./determinism.md) — `alwaysReplay` surfaces journal-shape divergence.
- [Verification + migration notes](./verification.md) — how the example suite gates CI.
- [decision 0017](../vrs/.decisions/0017-swappable-test-env.md) — the swappable `RestateTestEnv` façade.
- [decision 0013](../vrs/.decisions/0013-in-memory-test-context.md) — the in-memory context rationale.
- [decision 0009](../vrs/.decisions/0009-effect-native-testing-harness.md) — the native-server harness rationale.
