# Pattern: vitest-collection

**Area:** Testing **Kind:** semantic CI gate **Our usage:** 63 `@effect/vitest` import sites and
Schema-derived property tests.

## v3

```ts
live.prop('record', { count: Schema.Int, payload: Payload }, ({ count, payload }) =>
  Effect.sync(() => assertPayload(count, payload)),
)
```

## v4

```ts
live.prop('record', { count: Schema.Int, payload: Payload }, ({ count, payload }) =>
  Effect.sync(() => assertPayload(count, payload)),
)
```

At beta.99 the public form is unchanged; `@effect/vitest` normalizes record values with
`Schema.toArbitrary`.

## Equivalence

```sh
bun run run:pattern vitest-collection
```

IDENTICAL. Both majors collect one array-form and one record-form property test, then execute all
four schema shapes: primitive integer, primitive string, struct, and optional struct field. The
normalized report is two suites/tests passed with no collection failure.

The gate must execute Vitest as a child process from a cold invocation. Calling a property helper
inside an already-collected test cannot detect collection-time failures.

## Intended differences (alignment register entries)

- None. The beta.98 record-form regression is fixed in target beta.99.

## Gotchas

- Keep both array and record forms; the upstream regression affected only record normalization.
- Assert process exit status. A CI cell that prints the collection error but exits zero is not a
  gate.
- `@effect/vitest` remains a separate package at the unified Effect version; core test primitives
  move to direct `effect/testing/*` modules.
- Plain synchronous `prop` and Effectful `live.prop` have different Schema support; use the API
  actually present in effect-utils rather than assuming they normalize identically.

## Codemod rule

For test primitives only:

```text
effect/FastCheck -> effect/testing/FastCheck
```

Keep runner imports from `@effect/vitest`; do not rewrite them to `effect/testing`.

## Scoped test methods: one axis disappeared

V3 test methods varied on two independent axes:

```text
environment: TestEnv / test clock  <->  live services / real clock
scope:       unscoped              <->  scoped
```

Beta.102 always provides a runner-owned `Scope`, so only the environment/clock axis remains:

| v3              | v4          | Clock      | Scope    |
| --------------- | ----------- | ---------- | -------- |
| `it.scoped`     | `it.effect` | test clock | provided |
| `it.scopedLive` | `it.live`   | real clock | provided |

This is **VERIFIED** against the installed beta.102 declarations and implementation:

- `MethodsNonLive.effect` is `Tester<R | Scope.Scope>` and runs `Effect.scoped` before providing
  `TestEnv`;
- `Methods.live` is `Tester<Scope.Scope>` and is built with `Effect.scoped`;
- concrete `otelite` tests call effects requiring `Scope` under `it.live`.

The migration is not “remove `scoped` wherever it appears.” Preserve the clock half:
`scoped -> live` silently swaps the test clock for real time, while `scopedLive -> effect` silently
does the reverse. Either can compile and then change timeout, sleep, retry, or scheduling behavior.

For scoped test migrations, replay resource finalizer count/order and the timing behavior exercised
by the test. A test that merely starts successfully proves neither clock selection nor scope
teardown.
