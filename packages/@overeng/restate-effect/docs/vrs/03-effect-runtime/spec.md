# Spec: 03-effect-runtime

Specifies the determinism layer (journaled Clock/Random + explicit durable
waits), deterministic durable concurrency, the nondeterminism/durability lints,
and the replay-aware logger. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R17–R20, R37.

## 1. Determinism layer

Traces: R17–R20. See [../.decisions/0004](../.decisions/0004-determinism-layer.md),
[../.decisions/0005](../.decisions/0005-deterministic-concurrency.md). POC
reference: `RestateContext.run` / `.sleep`.

### 1.1 Clock / Random + explicit durable waits

The per-invocation boundary (see
[01-authoring](../01-authoring/spec.md#per-invocation-runtime-boundary), step 2)
provides journaled time/random over the handler runtime — but durable waits are
EXPLICIT, not a transparent `Clock.sleep` remap:

| Effect read                       | Backed by               | Effect                                                                   |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `Clock.currentTimeMillis` (async) | `ctx.date`              | reads journaled time                                                     |
| `Clock.unsafeCurrentTime*` (sync) | per-attempt frozen base | seeded once from `ctx.date.now()` at entry; does not advance mid-attempt |
| `Random`                          | `ctx.rand`              | seeded, journaled (`ctx.rand.random` / `uuidv4`)                         |

`Clock.unsafeCurrentTimeMillis` / `unsafeCurrentTimeNanos` are synchronous and
cannot call the async `ctx.date`, so they read a per-attempt frozen monotonic
base seeded once at handler entry. Time not advancing mid-attempt is the
deterministically-correct behavior: a replayed attempt must observe the same time
(R17).

Durable waits are EXPLICIT combinators — the binding does NOT remap `Clock.sleep`
to `ctx.sleep` (T02, R18):

| Combinator        | Backed by                  | Use                             |
| ----------------- | -------------------------- | ------------------------------- |
| `Restate.sleep`   | `ctx.sleep`                | durable timer                   |
| `Restate.timeout` | `RestatePromise.orTimeout` | durable race against a deadline |
| `Restate.race`    | `RestatePromise.race`      | durable race of descriptors     |

Every durable combinator has a CLEAN `E` (no `RestateError`, see
[04-error-boundary](../04-error-boundary/spec.md#error-boundary), item #1): an
infra failure is a defect classified at the boundary, so a handler with no
declared domain error keeps `E = never`. Explicit signatures:

```ts
Restate.run<A, E, R>(name, effect: Effect<A, E, R>, options?)
                                : Effect<A, E,    Exclude<R, DurableCaps> | RestateContext>  // inner E only
Restate.runExit<A, E, R>(name, effect, options?)
                                : Effect<Exit<A, E>, never, Exclude<R, DurableCaps> | RestateContext>  // observe (sagas)
Restate.sleep(millis, name?)    : Effect<void,            never, RestateContext>
Restate.timeout<A>(descr, millis): Effect<A | undefined,  never, RestateContext>
Restate.all<T>(descriptors)     : Effect<ResultsOf<T>,         never, RestateContext>
Restate.race<T>(descriptors)    : Effect<ResultsOf<T>[number], never, RestateContext>
Restate.any<T>(descriptors)     : Effect<ResultsOf<T>[number], never, RestateContext>
State.for(S).get/set/clear/clearAll/stateKeys : Effect<…, never, StateRead|StateWrite | RestateContext>
Awakeable.make(S)               : Effect<{ id; promise: Effect<T, never, never>; descriptor: Descriptor<T> }, never, RestateContext>
```

A bare in-handler `Effect.sleep` stays non-durable (pure in-handler timing only).
Remapping `Clock.sleep` was rejected because `Effect.timeout` is internally a race
against `Clock.sleep` + interruption — it would suspend/interleave
nondeterministically — and because library/AppLayer sleeps would silently journal
durable timers ([../.decisions/0004](../.decisions/0004-determinism-layer.md)).

### 1.2 Deterministic concurrency

Parallel durable operations must journal in source order or replay diverges.

```
sequential (Effect.gen)         : safe, no special handling
pure in-handler concurrency     : allowed (Effect.all over non-durable effects)
durable concurrency             : Restate.all / Restate.race / Restate.any  (R19)
raw fiber over durable ops      : guarded / lint-flagged
```

`Restate.all` / `race` / `any` take durable-op DESCRIPTORS, not opaque Effects:

```
Restate.all([descriptorA, descriptorB, …])
  1. issue descriptors SYNCHRONOUSLY in array order → RestatePromise[]   (fixes journal order)
  2. RestatePromise.all(promises)                    → one RestatePromise
  3. Effect.tryPromise(() => awaitOnce(combined)).pipe(Effect.map(...))   (await exactly once, map after)
```

A descriptor is a tagged value per durable op (`run`, `call`, `sleep`,
`awakeable`, `promiseGet`, …) carrying what is needed to issue it. ALL durable ops
expose a descriptor for the deterministic combinators (#2), so any of them joins
`Restate.all`/`race`/`any` in journal-source order:

| Durable op      | Descriptor                                              |
| --------------- | ------------------------------------------------------- |
| `run`           | `Restate.runDescriptor(name, action)`                   |
| `sleep`         | `Restate.sleepDescriptor(millis, name?)`                |
| service `call`  | `Restate.callDescriptor(contract, method, input)`       |
| object `call`   | `Restate.objectCallDescriptor(contract, key, m, input)` |
| durable promise | `DurablePromise.for(S).getDescriptor(name)`             |
| **awakeable**   | `Awakeable.make(S).descriptor`                          |

The awakeable's completion promise is itself a `RestatePromise`, so its descriptor
just hands the existing promise to the combinator. This replaces the in-process
`Effect.raceFirst` workaround (which would await an awakeable on a forked fiber,
losing journal-order determinism — THAT was the bug). The composed `pollLoop` wake
mode (see [06-scheduling](../06-scheduling/spec.md),
[../.decisions/0012](../.decisions/0012-self-reschedule.md)) is exactly this
pattern: its inter-cycle wait is
`Restate.race([sleepDescriptor(delay), wake.descriptor])`, a deterministic race of
a durable timer against an awakeable, so a webhook resolution cuts the wait short
while replay stays journal-deterministic.

This is deliberately NOT `Effect.all` over `[Effect.tryPromise(ctx.run…), …]`:
that path never calls `RestatePromise.all`, and Effect's own thunk-scheduling — not
the source order — would decide the journal order. Each `RestatePromise` is awaited
EXACTLY ONCE; transforms apply via `.map` to the RESULT after awaiting, never
`.then`-chained pre-await (the SDK overloads `.then` to detect suspension points).
Post-combinator mapping applies to the result, not the branches
([../.decisions/0005](../.decisions/0005-deterministic-concurrency.md)).

CONFIRMED (DQ2) against the real SDK: `RestatePromise.all`/`race`/`any` take a
`readonly RestatePromise<unknown>[]` backed by a leaf/descriptor model, and `.then`
is the SDK's progress/suspension seam (hence the `.map`-not-`.then` invariant); the
descriptor type shape rejects an arbitrary `Effect[]` and recovers a precise
tuple/union.

### 1.3 Nondeterminism + durability lints

Two oxlint rules (`@overeng/oxc-config`) backstop handler `src/` (both EXEMPT for
test + harness/testing infra files — `*.test.ts`, `testing.ts`, `TestContext.ts`,
`test/**` — where polling / live-clock sleeps are legitimate):

- `overeng/no-raw-nondeterminism` flags raw nondeterminism in handler bodies —
  `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, and
  un-journaled I/O — OUTSIDE `Restate.run` and the journaled Clock/Random, as an
  advisory backstop; the journaled layer + explicit combinators are the primary
  guarantee (R20). INSIDE a `Restate.run` closure nondeterminism is fine: the `run`
  result is journaled once, so a `crypto.randomUUID()` or the journaled `Random` is
  recorded on the first real execution and replayed verbatim. (`ctx.rand` inside
  `ctx.run` is not SDK-enforced in restate-sdk 1.14.5 — the guard is a no-op — and
  is harmless anyway, being journaled-seeded; the lint keeps nondeterminism inside
  `run` or the journaled sources, it does not police the inside of a `run` closure.)
- `overeng/no-non-durable-wait` flags a non-durable `Effect.sleep` / `Effect.timeout`
  in a handler body (it schedules an in-process timer that does NOT survive
  suspension/replay), steering to `Restate.sleep` / `Restate.timeout` (which journal
  a durable timer). It is about DURABILITY, not determinism (a bare `Effect.sleep`
  is perfectly deterministic, just not durable). EXEMPT inside a `Restate.run`
  closure — there the wait is part of a single journaled step.

### 1.4 Determinism hazards (verified — no extra rule needed)

Two stress-run claims were verified rather than turned into new rules:

- "A nested journaled op inside `Restate.run`" IS a hazard — but it is already
  PREVENTED at the type level by the run-scrubbing (`Exclude<R, DurableCaps>`, see
  [01-authoring](../01-authoring/spec.md#typed-capability-marker-context-model)): a
  nested `State.get` / `Restate.sleep` inside a `run` closure is a COMPILE error
  (asserted in `capability-inference.types.ts`). No new rule needed.
- "Gating a `Restate.run` on a `State.get`" is NOT a hazard. `State.get` is a
  journaled, deterministic read in the HANDLER BODY (not inside the closure); gating
  on it replays identically, so it is the legitimate pattern. Confirmed legal
  (`capability-inference.types.ts`); no rule should flag it.

---

## 2. Logging — `Logger` → replay-aware `ctx.console`

Traces: R37. See
[../.decisions/0015](../.decisions/0015-logger-ctx-console-bridge.md).

UNLIKE traces/metrics (see [08-observability](../08-observability/spec.md)),
logging is on the CORE `.` export (no `./otel`). A per-invocation
`loggerLayer(ctx)` (`Logger.replace(Logger.defaultLogger, …)`) is provided over
every handler effect ALONGSIDE `determinismLayer` in every `materialize*` path, so
an in-handler `Effect.log*` routes into the invocation's `ctx.console`:

- **Replay-suppressed.** `ctx.console` automatically excludes output during replay,
  so a single `Effect.logInfo` emits ONCE on the real execution — not on every
  replay/attempt (the bug the default `globalThis.console`-backed logger has). This
  rides the SAME non-replay knowledge the OTel path uses (see
  [08-observability](../08-observability/spec.md#metrics-path)).
- **Level + context for free.** `ctx.console` honors `RESTATE_LOGGING` and stamps
  each line with the invoked service/handler + invocation id. The Effect `LogLevel`
  maps to the `Console` method (`Trace`/`Debug` → `debug`, `Info` → `info`,
  `Warning` → `warn`, `Error`/`Fatal` → `error`).
- **Effect's format.** The line is produced by `Logger.logfmtLogger.log`, so log
  annotations (`Effect.annotateLogs`), spans, fiber id, and cause ride along; only
  the SINK changes.

A log line is NOT durable — suppressed on replay, never journaled. For
side-effecting telemetry route it through `Restate.run` (the exactly-once seam, see
[08-observability](../08-observability/spec.md#metrics-path)). The endpoint's OWN
startup log (`Endpoint.ts`) is OUTSIDE a handler and keeps the process default
logger. Verified server-free (`src/Runtime.test.ts`): routing to the matching
`ctx.console` method + no double-emit under replay.
