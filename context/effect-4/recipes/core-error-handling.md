# Pattern: core-error-handling

**Area:** Effect error handling and async constructors **Kind:** mixed **Our usage:** the
`catchAll*` family has 123 sites across 47 files and 14 packages; `Effect.async` has 13 sites
across 7 files.

## Shape change first

`Effect.callback` keeps the v3 `Effect.async` registration model: resume with an `Effect`, use the
provided `AbortSignal`, and optionally return an interruption cleanup `Effect`. The v3
`blockingOn` second argument is gone, and v4 binds its scheduler as the registration function's
`this`. Do not silently discard `blockingOn` at a site that used it.

## v3

```ts
const read = Effect.async<string, Error>((resume, signal) => {
  const handle = startRead({
    signal,
    done: (value) => resume(Effect.succeed(value)),
    failed: (error) => resume(Effect.fail(error)),
  })
  return Effect.sync(() => handle.cancel())
})

const recovered = program.pipe(
  Effect.catchAll((error) => recover(error)),
  Effect.catchAllCause((cause) => reportCause(cause)),
  Effect.catchAllDefect((defect) => reportDefect(defect)),
)
```

## v4

```ts
const read = Effect.callback<string, Error>((resume, signal) => {
  const handle = startRead({
    signal,
    done: (value) => resume(Effect.succeed(value)),
    failed: (error) => resume(Effect.fail(error)),
  })
  return Effect.sync(() => handle.cancel())
})

const recovered = program.pipe(
  Effect.catch((error) => recover(error)),
  Effect.catchCause((cause) => reportCause(cause)),
  Effect.catchDefect((defect) => reportDefect(defect)),
)
```

## Rename sheet

| v3                      | v4                   | Measured exposure              |
| ----------------------- | -------------------- | ------------------------------ |
| `Effect.catchAll`       | `Effect.catch`       | 112 sites / 47 files / 14 pkgs |
| `Effect.catchAllCause`  | `Effect.catchCause`  | 7 sites / 6 files / 4 pkgs     |
| `Effect.catchAllDefect` | `Effect.catchDefect` | 4 sites / 4 files / 3 pkgs     |
| `Effect.async`          | `Effect.callback`    | 13 sites / 7 files             |

## Equivalence

The v4 symbols and callback signature were verified directly in the
`effect@4.0.0-beta.102` tarball (SHA-1
`f51092854960f60cbdb06bd59e788acbc8ee8492`). This recipe does not replace a slice's
differential proof.

For callback sites, compare success and failure values, abort timing, registration count, and
cleanup count under interruption. For catch sites, compare the encoded success/error output and
confirm that `catch` still leaves defects unhandled while `catchCause` and `catchDefect` retain
their broader boundaries.

## Intended differences (alignment register entries)

None. These migrations preserve the existing recovery and interruption boundaries.

## Gotchas

- `Effect.catch` catches typed errors, not defects. Do not broaden it to `catchCause` just because
  a neighboring site inspects a `Cause`.
- The callback must resume with an `Effect`, not a raw value or error.
- Preserve interruption cleanup. Moving cleanup only onto the `AbortSignal` listener can change
  ordering; dropping the returned cleanup effect can leak the registered resource.
- A v3 `Effect.async` site with a `blockingOn` argument needs an explicit local rewrite; v4
  `Effect.callback` has no corresponding argument.

## Codemod rule

The three `catchAll*` replacements are safe identifier rewrites. Rename `Effect.async` only after
confirming the call has no second `blockingOn` argument, then retain the registration callback and
cleanup effect unchanged.
