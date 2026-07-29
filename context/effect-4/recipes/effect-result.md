# Pattern: effect-result

**Area:** Effect error materialization / Result **Kind:** shape change **Our usage:** 131 reported
`Effect.either` sites; the earlier full-source inventory measured 118 sites across 42 files before
13 additional slice sites were reported.

## Shape change first

V3 materialized the typed error channel as `Either`. V4 materializes it as `Result`:

```ts
// v3
const either = yield * Effect.either(program)

if (Either.isRight(either)) {
  use(either.right)
} else {
  recover(either.left)
}
```

```ts
// v4
const result = yield * Effect.result(program)

if (Result.isSuccess(result)) {
  use(result.success)
} else {
  recover(result.failure)
}
```

## Migration table

| v3                      | v4                        |
| ----------------------- | ------------------------- |
| `Effect.either(effect)` | `Effect.result(effect)`   |
| `Either.right(value)`   | `Result.succeed(value)`   |
| `Either.left(error)`    | `Result.fail(error)`      |
| `Either.isRight(value)` | `Result.isSuccess(value)` |
| `Either.isLeft(value)`  | `Result.isFailure(value)` |
| `either.right`          | `result.success`          |
| `either.left`           | `result.failure`          |
| `_tag: "Right"`         | `_tag: "Success"`         |
| `_tag: "Left"`          | `_tag: "Failure"`         |
| `Either.mapLeft`        | `Result.mapError`         |

Do not stop after renaming `Effect.either`: every downstream guard, match arm, property access,
constructor, serialized tag, and test expectation must move to the `Result` shape.

## Equivalence

The API and shape are **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A direct probe normalized:

```text
Effect.succeed(7) -> Success(7)
Effect.fail("bad") -> Failure("bad")
```

Both majors produced identical normalized success values and typed failures. In both, the
materialized effect itself cannot fail in the typed error channel.

Owning slices must compare any observable encoded representation. A raw `JSON.stringify` or
snapshot changes `_tag` and property names even when the normalized value is equivalent.

## Intended differences

None at internal control-flow sites. If an `Either` value crosses a wire, persistence, logging, or
snapshot boundary, preserving or intentionally changing its bytes requires a separate alignment
decision.

## Gotchas

- `Result` is not `Exit`: a `Result.Failure` contains the typed error directly, not a `Cause`.
- Defects and interruption are not converted into `Result.Failure`; `Effect.result` materializes
  the typed error channel, matching v3 `Effect.either`.
- Do not leave `_tag === "Right"` checks or `.right` reads behind; they are runtime shape checks,
  not only types.
- Serialized `Either` and `Result` objects are not byte-identical.

## Codemod rule

The producer rename is mechanical only together with the complete downstream shape rewrite.
Boundary encoders, snapshots, and pattern matches require per-site review.
