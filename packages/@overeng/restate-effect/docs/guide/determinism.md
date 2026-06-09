# Determinism

[← Handbook index](./README.md)

Restate replays handlers to recover their state, so every source of nondeterminism
must be journaled or the replay diverges. This binding makes the common cases
correct by construction. The full file is
[`examples/05-determinism.ts`](../../examples/05-determinism.ts).

## Journaled Clock and Random

Effect's `Clock` and `Random` are backed by the journaled context, so idiomatic
reads are replay-safe — no special API:

```ts
import { Clock, Effect, Random } from 'effect'

const at = yield * Clock.currentTimeMillis // journaled (ctx.date) — a replay reads the same instant
const roll = yield * Random.nextIntBetween(1, 7) // journaled (ctx.rand) — seeded, replay-stable
```

| Effect read                       | Backed by               | Behavior                                                       |
| --------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `Clock.currentTimeMillis` (async) | `ctx.date`              | reads journaled time                                           |
| `Clock.unsafeCurrentTime*` (sync) | per-attempt frozen base | seeded once at handler entry; does **not** advance mid-attempt |
| `Random.*`                        | `ctx.rand`              | seeded, journaled                                              |

The sync `Clock.unsafeCurrentTime*` reads a per-attempt frozen base. Time not
advancing mid-attempt is the deterministically-correct behavior: a replayed attempt
must observe the same time.

## Side effects and raw nondeterminism go inside `Restate.run`

A side effect or a raw nondeterministic call (`crypto.randomUUID()`, an external
fetch) goes inside `Restate.run`, whose result is journaled once and replayed
verbatim:

```ts
const token =
  yield *
  Restate.run(
    'mint-token',
    Effect.sync(() => crypto.randomUUID()),
  )
```

Inside a `run` closure, a nested `ctx.*` / `State.*` / `Restate.sleep` is a compile
error (the durable capabilities are scrubbed). See [Durable steps](./durable-steps.md).

## Durable waits are explicit

Durable waits are **explicit**, named combinators — **not** a remap of
`Effect.sleep`. `Restate.sleep` / `timeout` / `race` / `all` / `any` become
Restate-durable timers/races that survive suspension and restarts. A bare
`Effect.sleep` stays a non-durable in-process timer (use it only for in-handler
timing).

```ts
yield * Restate.sleep(10, 'settle') // a durable timer (lower bound; survives restarts)
```

> Why not remap `Clock.sleep`? `Effect.timeout` is internally a race against
> `Clock.sleep` + interruption — remapping would suspend/interleave
> nondeterministically — and library/AppLayer sleeps would silently journal durable
> timers. See [decision 0004](../vrs/decisions/0004-determinism-layer.md).

## Deterministic concurrency takes descriptors

Durable concurrency takes **descriptors** (not opaque Effects) so the journal order
is the source order. The combinator awaits the single combined promise once; map the
result after:

```ts
// race two durable steps; result is the first to resolve
Restate.race([
  Restate.runDescriptor('fetch-a', () => fetchA()),
  Restate.runDescriptor('fetch-b', () => fetchB()),
])

// bound one durable step by a deadline: the value, or undefined on timeout
Restate.timeout(
  Restate.runDescriptor('slow-op', () => slow()),
  1_000,
)
```

Every durable op exposes a descriptor for `all` / `race` / `any` / `timeout`:

| Durable op      | Descriptor                                                   |
| --------------- | ------------------------------------------------------------ |
| `run`           | `Restate.runDescriptor(name, action)`                        |
| `sleep`         | `Restate.sleepDescriptor(millis, name?)`                     |
| service `call`  | `Restate.callDescriptor(contract, method, input)`            |
| object `call`   | `Restate.objectCallDescriptor(contract, key, method, input)` |
| durable promise | `DurablePromise.for(S).getDescriptor(name)`                  |
| awakeable       | `Awakeable.make(S).descriptor`                               |

The combinators issue descriptors synchronously in array order (fixing the journal
order), then await the single combined `RestatePromise` exactly once. Apply
transforms with `.map` to the **result**, never `.then`-chained pre-await — the SDK
overloads `.then` to detect suspension points. This is deliberately not `Effect.all`
over `[Effect.tryPromise(ctx.run…)]` (which would let Effect's thunk scheduling, not
the source order, decide the journal order).

## The durability lints

Two oxlint rules backstop handler `src/` code (both exempt for test + harness/testing
infra files, where polling / live-clock sleeps are legitimate):

- **`overeng/no-raw-nondeterminism`** flags a raw `Date.now()` / `new Date()` /
  `Math.random()` / `crypto.randomUUID()` / un-journaled I/O in a handler body
  _outside_ `Restate.run` and the journaled Clock/Random. Inside a `Restate.run`
  closure nondeterminism is fine (it is journaled once).
- **`overeng/no-non-durable-wait`** flags a non-durable `Effect.sleep` /
  `Effect.timeout` in a handler body (it schedules an in-process timer that does not
  survive suspension/replay), steering to `Restate.sleep` / `Restate.timeout`. It is
  about **durability**, not determinism (a bare `Effect.sleep` is deterministic, just
  not durable). Exempt inside a `Restate.run` closure.

Both are advisory backstops; the journaled layer + explicit combinators are the
primary guarantee.

## A note on journal-shape sensitivity

The determinism layer increases the journal's sensitivity to ordinary Effect
refactors: reordering durable ops, adding/removing a `Restate.run`, or changing
combinator order alters the journal shape and is a redeploy/replay hazard the lint
does **not** catch. The mitigation is testing — the harness's multi-deployment
registration and `alwaysReplay` mode (see [Testing](./testing.md)) let a test replay
an in-flight journal against a new endpoint version and assert it still converges.

## See also

- [Durable steps](./durable-steps.md) — `Restate.run` and the descriptor surface.
- [Testing](./testing.md) — `alwaysReplay` and the determinism-hunting flags.
- [Cancellation and lifecycle](./cancellation.md) — durable await points and interruption.
