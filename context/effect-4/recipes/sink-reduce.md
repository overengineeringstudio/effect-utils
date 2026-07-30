# Pattern: sink-reduce

**Area:** Stream sinks **Kind:** constructor rename with evaluation-shape change **Our usage:**
constant-memory git status line counters in `megarepo`.

## v3

```ts
Sink.foldLeft<number, string>(0, (count, line) => (line.trim() === '' ? count : count + 1))
```

## v4

```ts
Sink.reduce<number, string>(
  () => 0,
  (count, line) => (line.trim() === '' ? count : count + 1),
)
```

V4 `Sink.reduce` is the direct pure, consume-all-input replacement. Its initial state is a
`LazyArg`, so the seed is supplied as a function.

## Equivalence

The constructor signatures are **VERIFIED** against the real tarballs. A cross-major stream probe
over empty, non-empty, and whitespace-only strings produced the same final count (`2`).

Both forms consume the entire stream, update once per element, retain no leftovers, and use
constant accumulator memory.

## Seed-evaluation trap

V3 receives an already-evaluated seed. V4 evaluates its seed once per sink run. For a dynamic or
effectful-looking expression, preserve v3 timing by hoisting:

```ts
const seed = makeSeed()
const sink = Sink.reduce(() => seed, update)
```

Writing `Sink.reduce(() => makeSeed(), update)` intentionally changes construction-time evaluation
into per-run evaluation and may create fresh mutable state.

## Intended differences

None.

## Codemod rule

`Sink.foldLeft(seed, update)` becomes `Sink.reduce(() => seed, update)`. Hoist non-trivial seed
expressions first when their original evaluation timing matters.
