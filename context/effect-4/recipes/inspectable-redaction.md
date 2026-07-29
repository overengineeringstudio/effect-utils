# Pattern: inspectable-redaction

**Area:** Logging / inspection / secrets **Kind:** rename and module move **Our usage:** file logger
JSON rendering and redaction.

## Migration table

| v3                      | v4                      |
| ----------------------- | ----------------------- |
| `Inspectable.toJSON(x)` | `Inspectable.toJson(x)` |
| `Inspectable.redact(x)` | `Redactable.redact(x)`  |

Import `Redactable` from the `effect` root for the second replacement. Redaction was moved, not
removed; dropping the call can expose secret values in logs.

## Equivalence

The APIs and behavior are **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A cross-major probe used an object with a custom `toJSON`, a
nested array, and a `Redacted` secret. Both `toJSON`/`toJson` and both redaction paths produced the
same recursive JSON shape with the secret rendered as `"<redacted>"`.

## Intended differences

None.

## Gotchas

- `toJson` still invokes user-defined `toJSON()` methods; only the exported helper's capitalization
  changed.
- `Redactable.redact` returns `unknown`. Preserve the old boundary's validation or serialization
  after redaction.
- Never replace `Inspectable.redact` with identity or raw `JSON.stringify`.

## Codemod rule

The helper rename is mechanical. The module move additionally requires adding the `Redactable`
root import and preserving redaction before serialization.
