# Faithful in-memory test context for server-free logic tests

The binding ships a FAITHFUL in-memory `RestateContext` (`./testing`'s
`makeTestContext` / `makeTestContextLayer`) for SERVER-FREE unit tests of handler
LOGIC and State transitions. It is a REAL in-memory implementation of the durable
`ctx` — NOT a stub or mock:

- State is a real `Map` (`get`/`set`/`clear`/`clearAll`/`stateKeys`), round-tripped
  through the SAME `effectSerde` the real handler uses.
- `ctx.run(name, …)` executes the action ONCE and MEMOIZES it by `name` — a
  re-`run` of the same name returns the journaled value without re-executing (the
  in-memory analogue of Restate replaying a journaled step).
- `ctx.date` / `ctx.rand` are deterministic (seeded); `ctx.sleep` is a
  controllable no-op (resolves immediately by default).
- The layer provides the SAME capability-marker subset the real boundary provides
  per `handlerKind` (service / objectShared / objectExclusive / workflowShared /
  workflowRun), so a `State.set` in a read-only handler is still a compile error.

A test provides it over the real handler effect and asserts on the result AND the
State `Map`:

```ts
// seed a pre-condition in the backing State Map, run the REAL handler, assert the
// result AND the State transition — no server.
const state = new Map<string, unknown>([['count', 40]])
const layer = makeTestContextLayer({ state, key: 'cart-1' })
const next = await Effect.runPromise(CounterLive.impl.add(3).pipe(Effect.provide(layer)))
// next === 43; state.get('count') === 43
```

## Why a real in-memory impl, not a mock

The house rule is "avoid mocks; reuse the real implementation". The tension here is
that the REAL implementation is a native `restate-server` (the `./testing`
harness). Resolving it with a mock would violate the rule and lie about behavior;
resolving it by ALWAYS spawning a server makes fast handler-logic tests expensive.

The resolution: a real in-memory implementation of the `restate.ObjectContext`
surface, scoped to handler LOGIC. The combinators (`Restate.run` / `State.*` /
`Restate.sleep` / `Restate.key` / awakeables) run VERBATIM against it — no
special-casing — because it implements the same context surface the boundary
provides. So it is faithful to the combinator semantics it covers, just not to the
durable RUNTIME (which only the real server provides).

## What it does NOT model — use `RestateTestHarness` for these

This is the `unit` row of the test-layering table (spec §11.3). It deliberately
does not model:

- DURABILITY / REPLAY: no journal, no suspension, no re-attempt. A crash
  mid-handler is just a thrown error; it does not replay. (`alwaysReplay`
  journal-shape hunting has no journal to diverge.)
- SINGLE-WRITER / per-key concurrency: no write lock, no exclusive/shared
  serialization, no cross-invocation ordering.
- Cross-handler / cross-invocation effects: `Restate.call`/`send`,
  `Restate.reschedule`, delayed self-sends, durable promises resolved by ANOTHER
  invocation, and `pollLoop` recurrence — none route anywhere (no server to
  deliver to).

For any of these, the real-server harness (decision 0009) is the supported path.
The two are complementary: this for fast logic/State tests, the harness for
durability/replay/single-writer/journal-shape.

## Consequences

- `makeTestContext` / `makeTestContextLayer` are public `./testing` API and must
  stay faithful to the real boundary's capability provision (kept in lock-step
  with `Endpoint.materialize*`).
- The in-memory context is NOT a substitute for the harness — documented in the
  module JSDoc, the README, and spec §11.5 so a consumer does not mistake a green
  in-memory test for durability/replay coverage.

Status: accepted
