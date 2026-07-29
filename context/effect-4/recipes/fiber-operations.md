# Pattern: fiber-operations

**Area:** Fiber **Kind:** mechanical

## Mapping

Effect 4 removes operation methods from Fiber instances. Use the module-level functions:

```ts
// v3
const exit = yield * fiber.await

// v4
const exit = yield * Fiber.await(fiber)
```

The same distinction between awaiting and joining remains: `Fiber.await(fiber)` succeeds with the
fiber's `Exit`, while `Fiber.join(fiber)` propagates the fiber's failure into the current Effect.

## Verification

Checked against `effect@4.0.0-beta.102` `Fiber.ts`: `await` is declared as
`<A, E>(self: Fiber<A, E>) => Effect<Exit<A, E>>`, and Fiber instances no longer expose `.await`.

## Gotchas

- Do not replace `fiber.await` with `Fiber.join(fiber)`. That changes failure observation into
  failure propagation.
- Preserve whether the caller inspects the returned `Exit` or joins the value.
