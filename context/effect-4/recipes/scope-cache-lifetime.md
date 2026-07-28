# Pattern: scope-cache-lifetime

**Area:** Scope and finalizers **Kind:** semantic **Our usage:** cached and pooled clients,
especially `effect-distributed-lock`.

## v3

```ts
Effect.scoped(
  Effect.gen(function* () {
    const cached = yield* Effect.acquireRelease(acquireClient, releaseClient)
    yield* Effect.scoped(handleRequest(cached))
    yield* handleRequest(cached)
  }),
)
```

## v4

```ts
Effect.scoped(
  Effect.gen(function* () {
    const cached = yield* Effect.acquireRelease(acquireClient, releaseClient)
    yield* Effect.scoped(handleRequest(cached))
    yield* handleRequest(cached)
  }),
)
```

The source form is unchanged. The migration obligation is to preserve which scope owns acquisition.

## Equivalence

```sh
bun run run:pattern scope-cache-lifetime
```

IDENTICAL. Both traces prove that the request finalizer runs when its request scope exits, the
cached client remains usable by a second request, and the client releases exactly once when the
server scope exits.

## Intended differences (alignment register entries)

- None.

## Gotchas

- Creating a cached client in the first request scope is invalid even if the cache itself has a
  server lifetime: the cached value is finalized with the request and later lookups return a dead
  resource.
- Anchor both the cache and its lookup/acquisition effect to the long-lived owner scope.
- Assert exact acquire/release order and cardinality. A value-level “second request succeeded” test
  alone does not detect double release at teardown.

## Codemod rule

None. Scope ownership cannot be inferred mechanically from syntax.
