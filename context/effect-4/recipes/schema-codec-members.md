# Pattern: schema-codec-members

**Area:** Schema codecs and members **Kind:** mixed, with an `Exit` shape change **Our usage:** 783
affected references in 159 files across about 25 packages. The removed `*Either` codec family alone
accounts for 28 references in 11 files and 6 packages.

## Shape change first: codecs return `Exit`

The non-throwing v3 `*Either` adapters become v4 `*Exit` adapters. This is not merely a rename:
callers receive `Exit`, whose success value is at `.value` and whose failure is a `Cause` at
`.cause`. There is no `.left` or `.right`.

## v3

```ts
const decoded = Schema.decodeUnknownEither(User)(input)
const encoded = Schema.encodeEither(User)(user)

if (Either.isRight(decoded)) {
  use(decoded.right)
}
```

## v4

```ts
import { Exit, Schema } from 'effect'

const decoded = Schema.decodeUnknownExit(User)(input)
const encoded = Schema.encodeExit(User)(user)

if (Exit.isSuccess(decoded)) {
  use(decoded.value)
} else {
  report(decoded.cause)
}
```

Use the corresponding unknown-input adapters when the value is not already typed:

| v3                    | v4                  |
| --------------------- | ------------------- |
| `decodeUnknownEither` | `decodeUnknownExit` |
| `decodeEither`        | `decodeExit`        |
| `encodeUnknownEither` | `encodeUnknownExit` |
| `encodeEither`        | `encodeExit`        |

## Codec and member migrations

After the `Exit` call sites are structurally repaired, apply the loud member migrations:

| v3                                          | v4                                    |
| ------------------------------------------- | ------------------------------------- |
| `Schema.parseJson()`                        | `Schema.UnknownFromJsonString`        |
| `Schema.parseJson(S)`                       | `Schema.fromJsonString(S)`            |
| `Schema.TaggedError`                        | `Schema.TaggedErrorClass`             |
| `.annotations(a)` / `Schema.annotations(a)` | `.annotate(a)` / `Schema.annotate(a)` |
| `Schema.decodeUnknown`                      | `Schema.decodeUnknownEffect`          |
| `Schema.decode`                             | `Schema.decodeEffect`                 |
| `Schema.encodeUnknown`                      | `Schema.encodeUnknownEffect`          |
| `Schema.encode`                             | `Schema.encodeEffect`                 |
| `Schema.compose(To)`                        | `Schema.decodeTo(To)`                 |
| `Schema.OptionFromSelf(S)`                  | `Schema.Option(S)`                    |
| `Schema.Redacted(S)`                        | `Schema.RedactedFromValue(S)`         |
| `Schema.DateFromSelf`                       | `Schema.Date`                         |

`Schema.encode` is also a surviving-name trap: it exists in v4 as a schema transformation
constructor. Parser call sites must move to `Schema.encodeEffect`; leaving the old name can bind to
the wrong operation instead of producing a simple missing-export error.

`Redacted` is a surviving-name trap. V4 `Schema.Redacted(S)` validates values that are already
`Redacted`; `Schema.RedactedFromValue(S)` preserves the v3 behavior of decoding a raw value and
wrapping it.

The Date pair is another surviving-name trap: v3 `DateFromSelf` becomes v4 `Date`, while v3 `Date`
wire schemas become v4 `DateFromString`. Keep those rewrites separate and follow the
`schema-date` recipe for the wire contract.

## Pretty-printed JSON

V4 has no pretty-print JSON codec. `Schema.fromJsonString(S)` accepts no formatting options and
serializes with plain `JSON.stringify`. When formatted JSON is a persisted wire format, encode the
value with the schema and stringify the encoded JSON value separately:

```ts
const encoded = Schema.encodeSync(Config)(value)
const content = JSON.stringify(encoded, null, 2)
```

Use `Schema.encodeEffect` instead when the surrounding path handles schema failures as an Effect.
Preserve any existing trailing newline separately. Compare the resulting bytes against the v3
baseline; accepting file churn is not a mechanical migration.

## Affected inventory

The measured codec/member heatmap is:

| Package                  |       Wave | References |
| ------------------------ | ---------: | ---------: |
| `megarepo`               |          6 |        176 |
| `notion-effect-schema`   |          2 |        149 |
| `notion-datasource-sync` |          7 |         65 |
| `restate-effect`         |          5 |         56 |
| `utils`                  |          4 |         44 |
| `notion-md`              |          6 |         43 |
| `ci-tools`               |          5 |         43 |
| `otel-contract`          |          3 |         41 |
| `tui-react`              |          5 |         25 |
| `effect-path`            |          2 |         25 |
| `notion-effect-client`   |          5 |         21 |
| `utils-dev`              |          1 |         21 |
| `content-address`        |          2 |         18 |
| `genie`                  |          6 |         17 |
| `notion-cli`             |          8 |          8 |
| `notion-react`           |          6 |          7 |
| `npm-release`            | unassigned |          7 |
| `effect-ai-claude-cli`   | unassigned |          6 |
| `agent-session-ingest`   | unassigned |         26 |
| `tui-stories`            |          7 |          4 |
| `effect-rpc-tanstack`    | unassigned |          2 |
| `notion-property-write`  |          3 |          2 |
| `kdl-effect`             |          3 |          2 |
| `kdl`                    |          2 |          1 |

The heatmap counts namespace-member expressions and includes `Exit` adapters. The 783-reference
headline also includes direct imports and type references.

## Equivalence

No repository migration is applied by this recipe. A slice must compare encoded bytes and normalized
success/failure traces for every migrated codec. An `Exit` conversion is complete only after all
callers, matchers, test helpers, and error formatters consume the new shape.

Every v4 symbol in this recipe was checked against the `effect@4.0.0-beta.102` npm tarball with
SHA-1 `f51092854960f60cbdb06bd59e788acbc8ee8492`.

## Gotchas

- `decodeUnknownEffect` and `encodeEffect` fail with `SchemaError`. Low-level transformation
  callbacks fail with `SchemaIssue.Issue`; do not interchange those error types.
- Do not infer safety from a surviving `Schema.encode` reference; its v4 meaning is unrelated to
  running a schema encoder.
- `fromJsonString(S)` parses the JSON string and then applies `S`.
  `UnknownFromJsonString` stops after JSON parsing.
- `decodeTo` names the target decoded schema. Verify transformation direction instead of mechanically
  swapping the old `compose` call.
- Do not add `Either` compatibility wrappers around `Exit`; that creates a migration-only dialect and
  hides unported callers.

## Codemod rule

The table entries are mechanical only when the old member's role is unambiguous. The `*Either`
family, `Redacted`, Date schemas, and custom `compose` chains require caller-aware rewrites and
boundary fixtures.
