# Pattern: random-bounds-semantics

**Area:** Random integer bounds **Kind:** semantic **Our usage:** `restate-effect` uses
`Random.nextIntBetween` for journaled deterministic values in runtime tests, examples, and the
determinism guide.

## Shape change first

Effect 3's `Random.nextIntBetween(min, max)` is half-open: it can return `min` but never `max`.
Effect 4 beta.102 makes the upper bound inclusive by default and adds an explicit option for the
old behavior.

| operation | lower bound | upper bound |
| --- | --- | --- |
| v3 `Random.nextIntBetween(min, max)` | inclusive | exclusive |
| v4 default `Random.nextIntBetween(min, max)` | inclusive | inclusive |
| v4 `Random.nextIntBetween(min, max, { halfOpen: true })` | inclusive | exclusive |

## v3

```ts
const index = yield* Random.nextIntBetween(0, values.length)
```

## v4

```ts
const index = yield* Random.nextIntBetween(0, values.length, { halfOpen: true })
```

Do not omit the option when porting a v3 call. An inclusive result equal to `values.length` can
turn a previously valid array index into `undefined`.

## Custom Random services

Effect 4's `Random.Random` Reference exposes only `nextIntUnsafe` and `nextDoubleUnsafe`; the
effectful operations derive from those primitives. When a v3 custom Random supplied its own
integer derivation, preserve that local arithmetic in `nextIntUnsafe` instead of substituting the
v4 default generator's full-safe-integer behavior.

For Restate's journaled service, the v3 implementation was:

```ts
const next = Effect.sync(() => ctx.rand.random())
const nextInt = Effect.map(next, (n) => Math.floor(n * Number.MAX_SAFE_INTEGER))
```

The equivalent v4 primitive service is:

```ts
const journaledRandom: (typeof Random.Random)["Service"] = {
  nextDoubleUnsafe: () => ctx.rand.random(),
  nextIntUnsafe: () => Math.floor(ctx.rand.random() * Number.MAX_SAFE_INTEGER),
}
```

This custom-service mapping is specific to that source-derived v3 implementation. It is not a
universal replacement for `Random.make`.

## Equivalence

The beta.102 implementation computes `extra = options?.halfOpen === true ? 0 : 1` before flooring
the scaled random value. A discriminating source value of `0.999` over `(0, 10)` returns `9` with
`{ halfOpen: true }` and can return `10` with the v4 default. Preserve the edge case in a runtime
test; mid-range values such as `0.42` do not distinguish the two semantics.

The API and arithmetic were verified directly against the
`effect@4.0.0-beta.102` tarball (SHA-1 `f51092854960f60cbdb06bd59e788acbc8ee8492`).

## Intended differences

None. The inclusive default is real breakage for v3 call sites and must be preserved with
`{ halfOpen: true }`.

## Codemod rule

Repository-owned v3 call sites can add `{ halfOpen: true }` mechanically after confirming they
target Effect's `Random.nextIntBetween`. Custom Random implementations require a source-derived
port of their primitive arithmetic.
