# Pattern: datetime-values

**Area:** DateTime values **Kind:** renames **Our usage:** construction and telemetry timestamp
access in `agent-session-ingest`, `otel-contract`, and `utils`.

## Migration table

| v3                       | v4                           |
| ------------------------ | ---------------------------- |
| `DateTime.unsafeMake(x)` | `DateTime.makeUnsafe(x)`     |
| `dateTime.epochMillis`   | `dateTime.epochMilliseconds` |

These are value-level `DateTime` APIs. Schema wire codecs are covered by the separate
`schema-date` recipe; do not confuse a value constructor rename with the surviving-name schema
hazard.

## Equivalence

Both replacements are **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A cross-major probe constructed values from epoch zero, an ISO
timestamp, and a native `Date`. Epoch milliseconds and formatted ISO output matched exactly for
all inputs.

## Intended differences

None.

## Gotchas

- The `unsafe` word moved; it was not removed. `makeUnsafe` can still throw for invalid input.
- Do not replace `unsafeMake` with safe `make` without handling its result type.
- `Schema.DateTimeUtc` is a different migration: v3's string codec becomes
  `Schema.DateTimeUtcFromString`, because bare v4 `Schema.DateTimeUtc` validates an existing
  `DateTime.Utc` value.

## Codemod rule

Both value-level renames are mechanical. Review every `Schema.DateTime*` occurrence using the
wire-vs-value pattern in `schema-date`.
