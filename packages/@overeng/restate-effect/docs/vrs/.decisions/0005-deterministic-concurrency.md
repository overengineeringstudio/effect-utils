# Deterministic parallelism via explicit Restate.all/race (descriptor-based, not raw Effect fibers)

Parallel durable operations must create their journal entries in a deterministic
(source) order or replay diverges. The binding provides explicit `Restate.all` /
`Restate.race` / `Restate.any` combinators. Raw `Effect.fork` and concurrent
`Effect.all`/`Effect.race` over durable operations inside a handler are unsafe
and are lint-flagged/guarded. Sequential durable operations (the common
`Effect.gen` case) need no special handling.

These combinators take durable-op DESCRIPTORS, not an array of opaque Effects.
The shape:

1. Accept descriptors (a tagged value per durable op — `run`, `call`, `sleep`,
   `awakeable`, `promiseGet`, …) carrying everything needed to issue it.
2. Issue them SYNCHRONOUSLY, in source/array order, to obtain the actual
   `RestatePromise[]` (this fixes journal order).
3. Hand that array to the SDK's `RestatePromise.all` / `.race` / `.any`.
4. Wrap the SINGLE resulting `RestatePromise` in one `Effect.tryPromise` / `.map`.

This is deliberately NOT `Effect.all` over an array of `Effect.tryPromise(ctx.*)`
thunks: that path never calls `RestatePromise.all`, and Effect's own
thunk-scheduling — not the source order — decides when each `ctx.*` op runs and
hence the journal order. The descriptor shape forces source-order issuance.

Invariant (`RestatePromise.then`): each `RestatePromise` is awaited EXACTLY ONCE.
The SDK overloads `.then` to detect suspension points, so the binding never
`.then`-chains a `RestatePromise` for transformation; it awaits once (one
`Effect.tryPromise` per `RestatePromise`) and transforms in Effect-land via
`.map`. Post-combinator mapping applies to the RESULT, never to a branch
pre-await.

## Why

- Restate journals each `ctx` op in issue order; nondeterministic fiber
  interleaving over durable ops produces nondeterministic journal order → RT0016
  on replay.
- Mirroring Restate's own parallel primitives (`RestatePromise.all/race/any`)
  keeps determinism explicit and robust, instead of betting correctness on
  Effect's (single-threaded but internal) fiber-scheduling order.

## Consequences

- Fan-out / scatter-gather goes through `Restate.all`/`race`/`any` over
  descriptors, not `Effect.all` with concurrency.
- Pure (non-durable) concurrency in a handler is still allowed; only concurrency
  over durable ops is constrained.

Status: accepted

_Revised: settled on the DESCRIPTOR shape (over an `Effect.all` of opaque thunks)
and the await-exactly-once `RestatePromise.then` invariant — both folded into the
body above._
