# Pattern: duration-input

**Area:** Duration **Kind:** renames **Our usage:** 10 workspace compiler diagnostics for
`Duration.DurationInput` on the current flip snapshot.

## Migration table

| v3                       | v4                                |
| ------------------------ | --------------------------------- |
| `Duration.DurationInput` | `Duration.Input`                  |
| `Duration.decode(input)` | `Duration.fromInputUnsafe(input)` |

V4's `fromInputUnsafe` is the replacement for the total, typed-input v3 `decode`. Keep
`Duration.fromInput` for unknown input that must report invalid data rather than throw.

## Equivalence

The aliases, signatures, and replacement are **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A cross-major probe compared milliseconds for the repository's
shared input forms: number, bigint nanoseconds, seconds/nanoseconds tuple, duration string, and
infinity. Every result matched.

V4 `Input` additionally accepts duration objects and explicit infinity strings. That widening does
not change existing v3-valid callers.

## Intended differences

None for existing inputs.

## Gotchas

- `fromInputUnsafe` is appropriate because the static `Input` type guarantees the accepted shape.
  Do not use it at an `unknown` boundary.
- A bigint duration input is nanoseconds in both versions, not milliseconds.
- Do not replace a `Duration.decodeUnknown` boundary mechanically; its validation/result shape
  needs separate handling.

## Codemod rule

The type and typed constructor renames are mechanical. Unknown-input parsers require per-site
review.
