# Pattern: layer-memoization

**Area:** Services and Layers **Kind:** semantic **Our usage:** tests and runtime setup use
`Effect.provide`, `Layer.effect`, `Layer.scoped`, and composed live/test layers.

## v3

```ts
program.pipe(Effect.provide(Live), Effect.provide(Live))
// acquire runs twice
```

## v4

```ts
program.pipe(Effect.provide(Live), Effect.provide(Live))
// acquire runs once

program.pipe(Effect.provide(Live, { local: true }), Effect.provide(Live))
// acquire runs twice

program.pipe(Effect.provide(Layer.fresh(Live)), Effect.provide(Live))
// acquire runs twice
```

## Explicit `Layer.memoize` ports

Deleting `Layer.memoize` is not a faithful port. Effect 4 does not memoize across separate builds:
two `Layer.buildWithScope` calls on one layer measured `acquisitions=2, same=false`. Deleting the
wrapper silently doubles every acquisition behind that layer.

To restore v3 sharing, thread one `Layer.makeMemoMap` through `Layer.buildWithMemoMap`. The equivalent
probe measured `acquisitions=1` with an identical service id.

Apply the shared map only where v3 shared. Independence is preserved by default: non-primary paths
measured `acquisitions=2, same=false, ids 1,2` in both majors. Threading one map too widely collapses
deployments that were deliberately isolated.

## Equivalence

Command:

```sh
bun run run layer-memoization
```

Result: default separate provides differ (`v3: 2`, `v4: 1`) and are allowlisted
as a semantic change. In this separate-provide probe, `Layer.fresh` preserves v3
construction count. v4 `{ local: true }` is available and also restores the v3
count when applied to the inner provide.

## Intended differences (alignment register entries)

- v4 shared memoization is accepted for normal application wiring, but tests and
  resource factories that require fresh state must use `Layer.fresh` or
  `{ local: true }`.
- Explicit v3 `Layer.memoize` sites that require sharing across builds must use
  one `Layer.makeMemoMap` with `Layer.buildWithMemoMap`.

## Gotchas

- A careless migration can silently reduce resource construction from two to one.
  That is usually good for live resources but wrong for tests expecting isolated
  state.
- `Layer.fresh` is not the replacement for `Layer.memoize`: it has inverted
  semantics. `fresh` defeats memoization; `memoize` enabled it.
- The placement of `{ local: true }` matters. In this probe, the inner provide is
  the placement that restores the v3 construction count.
