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

## Equivalence

Command:

```sh
bun run run layer-memoization
```

Result: default separate provides differ (`v3: 2`, `v4: 1`) and are allowlisted
as a semantic change. `Layer.fresh` preserves v3 construction count. v4
`{ local: true }` is available and also restores the v3 count when applied to the
inner provide.

## Intended differences (alignment register entries)

- v4 shared memoization is accepted for normal application wiring, but tests and
  resource factories that require fresh state must use `Layer.fresh` or
  `{ local: true }`.

## Gotchas

- A careless migration can silently reduce resource construction from two to one.
  That is usually good for live resources but wrong for tests expecting isolated
  state.
- The placement of `{ local: true }` matters. In this probe, the inner provide is
  the placement that restores the v3 construction count.
