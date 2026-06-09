# Testing (`./testing`)

[← Handbook index](./README.md)

The `./testing` subpath exports two complementary test surfaces: a **native-server
harness** (no Docker) for true end-to-end paths, and a **faithful in-memory
`TestContext`** for fast, server-free handler-logic tests.

## Test layering

The two core guarantees are server-free testable; only true end-to-end paths need
the integration job.

| Layer       | Needs server?       | Covers                                                                                                                                                          |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | no                  | serde round-trips, `toTerminal`, pure combinators, annotation read-back; AND server-free handler-logic / State-transition tests via the in-memory `TestContext` |
| contract    | no                  | error-transport round-trip (decode over a constructed `TerminalError`); OTel exactly-once via an in-memory `SpanExporter`                                       |
| integration | yes (native server) | real invoke/replay, State, awakeables, durable promises, single-writer, cross-invocation (calls/sends/`reschedule`/`pollLoop`), journal-shape (`alwaysReplay`)  |

## The native-server harness

`RestateTestHarness.layer({ services, appLayer })` is one scoped Layer that boots a
native `restate-server` (no Docker) on ephemeral ports against an isolated temp dir,
serves your endpoint with `appLayer` threaded into the served runtime, registers the
deployment, and exposes a typed ingress client + typed `stateOf` State inspection.
On release it shuts the server down and removes the temp dir. The full file is
[`examples/11-testing.ts`](../../examples/11-testing.ts); the `it.effect` assertions
live in [`src/examples.integration.test.ts`](../../src/examples.integration.test.ts).

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

The harness also supports multi-deployment registration, so a test can register two
endpoint versions and assert replay/upgrade across them.

## In-memory `TestContext` (server-free unit tests)

For fast unit tests of a handler's LOGIC and State transitions — no server, no
Docker — `./testing` also exports a FAITHFUL in-memory `RestateContext`. It is a real
in-memory implementation, not a stub: State is a real `Map` (round-tripped through
the same serde the handler uses), `Restate.run(name, …)` executes once and memoizes
by name (journaled-once), `ctx.date`/`ctx.rand` are deterministic (seeded), and
`ctx.sleep` is a controllable no-op. Verified by
[`src/TestContext.test.ts`](../../src/TestContext.test.ts).

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

`makeTestContextLayer({ handlerKind })` provides the SAME capability-marker subset
the real boundary provides per handler kind (`service` / `objectShared` /
`objectExclusive` / `workflowShared` / `workflowRun`), so a `State.set` in a
read-only handler is still a compile error. `makeTestContext(options)` is the
lower-level form (returns the fake `ctx` + the State `Map` + the `run` journal).

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
- [decision 0013](../vrs/decisions/0013-in-memory-test-context.md) — the in-memory context rationale.
