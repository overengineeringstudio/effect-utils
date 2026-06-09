# Determinism: journaled Clock/Random + explicit durable waits + nondeterminism lint

Inside the per-invocation handler runtime, the binding provides journaled
sources of nondeterminism and a lint backstop — but durable waits are EXPLICIT,
not a transparent global remap of `Effect.sleep` / `Effect.timeout`.

Provided over the handler runtime:

- `Clock.currentTimeMillis` backed by `ctx.date` (async; journaled time reads).
- `Random` backed by `ctx.rand` (sync; seeded, journaled — `ctx.rand.random` /
  `ctx.rand.uuidv4`).
- `Clock.unsafeCurrentTimeMillis()` / `unsafeCurrentTimeNanos()` are SYNC and
  CANNOT be backed by the async `ctx.date`. They are served from a per-attempt
  FROZEN monotonic base, seeded once from `ctx.date.now()` at handler entry.
  Wall-clock time therefore does not advance mid-attempt — which is the
  deterministically-correct behavior (a replayed attempt must observe the same
  time it observed when it first ran).

Durable waits and races are EXPLICIT combinators, never a global `Clock.sleep`
remap:

- `Restate.sleep` (durable timer, `ctx.sleep`).
- `Restate.timeout` (over `RestatePromise.orTimeout`).
- `Restate.race` (durable race; see [0005](./0005-deterministic-concurrency.md)).

An oxlint rule bans raw nondeterminism in handler bodies — `Date.now()`,
`new Date()`, `Math.random()`, `crypto.randomUUID()`, and un-journaled I/O —
OUTSIDE `Restate.run` and the journaled Clock/Random. INSIDE a `Restate.run`
closure both the journaled `Random` and a raw `crypto.randomUUID()` are fine: the
`run` result is journaled once, so any nondeterminism is recorded on the first
real execution and replayed verbatim. (`ctx.rand` inside `ctx.run` is not
SDK-enforced in restate-sdk 1.14.5 anyway — the guard is a no-op — and is harmless
because `ctx.rand` is journaled-seeded, hence reproducible.) The lint's job is to
keep nondeterminism inside `run` or the journaled sources, not to police the
inside of a `run` closure.

## Why

- Restate's deterministic-replay contract is load-bearing; Effect's default
  `Clock`/`Random`/scheduler read real time / PRNG / in-memory and silently break
  replay (RT0016). Backing them with `ctx` makes time/random reads
  correct-by-construction.
- A global `Clock.sleep → ctx.sleep` remap was REJECTED. Two reasons:
  - `Effect.timeout` is internally a RACE of the inner effect against
    `Clock.sleep` + interruption. With the remap, every `Effect.timeout` would
    suspend on a durable timer and interleave nondeterministically — the exact
    fiber-interleaving hazard that [0005](./0005-deterministic-concurrency.md)
    forbids.
  - Library / AppLayer code that happens to `Effect.sleep` (retries, debounce,
    rate-limiting) would silently journal durable timers it never intended,
    making the journal shape depend on transitive dependencies.
    Durable waits must be a deliberate, named choice.

## Consequences

- The author chooses a durable wait explicitly (`Restate.sleep` /
  `Restate.timeout` / `Restate.race`); a bare `Effect.sleep` stays non-durable
  and is for pure in-handler timing only.
- Determinism is VALIDATED end-to-end against native `restate-server` 1.6.2: a
  `Restate.run` side effect fires EXACTLY ONCE across replays and journaled
  `ctx.date.now()` reads are replay-stable. The frozen-per-attempt base for the
  sync `unsafeCurrentTime*` reads is a sound design; only the frozen-base sync
  clock itself stays to confirm against a representative handler in impl.
- The lint rule is an advisory backstop; the journaled Clock/Random and the
  explicit durable combinators are the primary guarantee.

Status: accepted

_Revised after design review (user resolution: explicit durable waits): dropped
the transparent `Clock.sleep → ctx.sleep` global remap (broke `Effect.timeout`
and silently journaled library sleeps); durable waits are now the explicit
`Restate.sleep` / `Restate.timeout` / `Restate.race` combinators. Added the
frozen-per-attempt monotonic base for the sync `unsafeCurrentTime*` reads._

_Revised after empirical de-risk: simplified the `ctx.rand`-in-`run` note —
`crypto.randomUUID()` and the journaled `Random` are both fine inside `Restate.run`
(`run` journals the result once; the SDK's `ctx.rand`-in-`run` guard is a no-op in
1.14.5 and is harmless either way). Determinism is validated end-to-end against
native restate-server 1.6.2 (exactly-once `run`, replay-stable journaled reads);
only the frozen-base sync clock stays to confirm in impl._
