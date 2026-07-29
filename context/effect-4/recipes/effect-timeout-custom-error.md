# Pattern: effect-timeout-custom-error

**Area:** Effect timeout control flow **Kind:** shape change **Our usage:** custom timeout failures
in `megarepo`, `utils`, `utils-dev`, and `restate-effect`.

## v3

```ts
program.pipe(
  Effect.timeoutFail({
    duration,
    onTimeout: () => new OperationTimeout(),
  }),
)
```

## v4

```ts
program.pipe(
  Effect.timeoutOrElse({
    duration,
    orElse: () => Effect.fail(new OperationTimeout()),
  }),
)
```

`timeoutFail` is absent at beta.102. `timeoutOrElse` is the replacement, but its fallback is an
`Effect`, not a raw error value. State the `Effect.fail` explicitly; replacing the removed API with
plain `timeout` would change the error type to `TimeoutException`.

## Equivalence

The replacement is **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A direct probe covered both branches:

- an immediately successful source returned the same value and did not evaluate the timeout error;
- a never-completing source timed out into the same normalized typed error;
- the lazy timeout constructor ran exactly once, only on the timeout branch.

Both implementations interrupt the source before producing the timeout failure.

## Intended differences

None.

## Gotchas

- Preserve laziness: `orElse: () => Effect.fail(onTimeout())`, not
  `orElse: Effect.fail(onTimeout())`.
- Use `Effect.fail`, not `Effect.die`, unless the v3 site used `timeoutFailCause`.
- Keep the original duration input and custom error payload unchanged.
- Test both branches. A timeout-only test does not prove the success path avoids constructing the
  error.

## Codemod rule

The outer call shape is predictable, but the error must be lifted into `Effect.fail`. Review
`timeoutFailCause` separately because its v3 failure is a Cause/defect boundary.
