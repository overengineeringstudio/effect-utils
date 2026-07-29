# Pattern: schema-constructor-shapes

**Area:** Schema constructors and field options **Kind:** shape change **Our usage:** 640 affected
references in 152 files across 27 packages. `Literal` alone accounts for 195 calls in 84 files.

## Shape changes first

These rewrites change arguments or the resulting field representation. Do not treat them as
find-and-replace renames.

| v3                                         | v4                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `Schema.Union(A, B)`                       | `Schema.Union([A, B])`                                                            |
| `Schema.Tuple(A, B)`                       | `Schema.Tuple([A, B])`                                                            |
| `Schema.Literal("a", "b")`                 | `Schema.Literals(["a", "b"])`                                                     |
| `Schema.Literal(null)`                     | `Schema.Null`                                                                     |
| `Schema.Record({ key: K, value: V })`      | `Schema.Record(K, V)`                                                             |
| `Schema.optionalWith(S, { as: "Option" })` | `Schema.OptionFromOptional(S)`                                                    |
| `Schema.optionalWith(S, { default })`      | `S.pipe(Schema.withDecodingDefaultType(...), Schema.withConstructorDefault(...))` |

The v4 constructors take one array or positional arguments exactly as shown. Accidentally preserving
the v3 call shape can construct the wrong runtime AST before a slice reaches a useful type error.

## v3

```ts
const Input = Schema.Struct({
  kind: Schema.Literal('created', 'updated'),
  payload: Schema.Union(Schema.String, Schema.Number),
  pair: Schema.Tuple(Schema.String, Schema.Number),
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  note: Schema.optionalWith(Schema.String, { as: 'Option' }),
  retries: Schema.optionalWith(Schema.Number, { default: () => 0 }),
})
```

## v4

```ts
import { Effect, Schema } from 'effect'

const Input = Schema.Struct({
  kind: Schema.Literals(['created', 'updated']),
  payload: Schema.Union([Schema.String, Schema.Number]),
  pair: Schema.Tuple([Schema.String, Schema.Number]),
  labels: Schema.Record(Schema.String, Schema.String),
  note: Schema.OptionFromOptional(Schema.String),
  retries: Schema.Number.pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => 0)),
    Schema.withConstructorDefault(Effect.sync(() => 0)),
  ),
})
```

## Optionality decision

`optionalWith` encoded several independent choices in one options object. Preserve the old choice
explicitly:

| v3 intent                                         | v4 form                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| key may be absent or `undefined`                  | `Schema.optional(S)`                                                     |
| key may be absent, but not present as `undefined` | `Schema.optionalKey(S)`                                                  |
| missing/`undefined` decodes to `Option.none()`    | `Schema.OptionFromOptional(S)`                                           |
| missing exact key decodes to `Option.none()`      | `Schema.OptionFromOptionalKey(S)`                                        |
| missing/`undefined` uses a decoded default        | `Schema.withDecodingDefaultType` plus `Schema.withConstructorDefault`    |
| missing exact key uses a decoded default          | `Schema.withDecodingDefaultTypeKey` plus `Schema.withConstructorDefault` |

The two default helpers cover different entry points and both are required for a faithful port:

```ts
const field = Schema.String.pipe(
  Schema.withDecodingDefaultType(Effect.sync(defaultValue)),
  Schema.withConstructorDefault(Effect.sync(defaultValue)),
)
```

`withDecodingDefaultType` preserves `decode({})`; by itself, its field still makes `Schema.make({})`
throw `Missing key`. `withConstructorDefault` preserves `Schema.make({})`; by itself, it does not
apply during decoding. For nullable or combined `optionalWith` options, write an explicit
`optional`/`optionalKey` plus `decodeTo` transformation, add the constructor default when v3 had a
default, and prove absent, `undefined`, `null`, present, decode, and make cases separately.

## Checks and refinements

A v3 boolean filter becomes a v4 check. A v3 type-guard filter becomes `refine` so the narrowed type
is preserved.

```ts
import { Option, Schema } from 'effect'

const NonEmpty = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || 'must not be empty'),
)

const Some = Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome))
```

`makeFilter` may return `undefined`/`true` for success, `false` or a string for one failure, a
`SchemaIssue.Issue`, a `{ path, issue }` object, or an array of those issues. Do not return old
`ParseResult` nodes from a v4 check.

## Affected inventory

The measured constructor/options heatmap is:

| Package                   |       Wave | References |
| ------------------------- | ---------: | ---------: |
| `notion-effect-schema`    |          2 |        189 |
| `megarepo`                |          6 |         77 |
| `notion-datasource-sync`  |          7 |         71 |
| `tui-react`               |          5 |         64 |
| `ci-tools`                |          5 |         29 |
| `notion-effect-client`    |          5 |         25 |
| `pty-effect`              |          4 |         22 |
| `agent-session-ingest`    | unassigned |         18 |
| `effect-path`             |          2 |         17 |
| `otel-contract`           |          3 |         14 |
| `utils`                   |          4 |         14 |
| `notion-cli`              |          8 |         13 |
| `restate-effect`          |          5 |         12 |
| `notion-md`               |          6 |         11 |
| `effect-schema-form-aria` |          5 |          9 |
| `react-inspector`         | unassigned |          9 |
| `genie`                   |          6 |          8 |
| `kdl-effect`              |          3 |          6 |
| `utils-dev`               |          1 |          6 |
| `notion-property-write`   |          3 |          5 |
| `notion-react`            |          6 |          5 |
| `effect-schema-form`      |          1 |          4 |
| `tui-stories`             |          7 |          4 |
| `content-address`         |          2 |          3 |
| `kdl`                     |          2 |          3 |
| `effect-rpc-tanstack`     | unassigned |          1 |
| `npm-release`             | unassigned |          1 |

The heatmap counts namespace-member expressions. The 640-reference headline also includes direct
imports and type references.

## Equivalence

No repository migration is applied by this recipe. Each owning slice must replay the v3/v4
differential harness and compare encoded bytes. For optional fields, the fixture matrix must include
an absent key, an explicit `undefined`, `null` where accepted, a present value, decode, encode, and
`Schema.make`.

Every v4 symbol in this recipe was checked against the `effect@4.0.0-beta.102` npm tarball with
SHA-1 `f51092854960f60cbdb06bd59e788acbc8ee8492`.

## Gotchas

- `Schema.optional` and `Schema.optionalKey` deliberately produce different TypeScript and runtime
  shapes.
- A v4 decoding default alone breaks v3 constructor behavior. The dual-helper form above is required
  even when decode fixtures are already green.
- A decoding default is also an encoding decision. Verify whether the old encoder emitted or omitted
  the default instead of choosing `encodingStrategy` by intuition.
- Preserve the old default callback's evaluation timing with `Effect.sync(default)`. Eagerly calling
  it while building the schema can share mutable default values across decodes.
- `Schema.Literal(value)` remains the v4 single-literal constructor; only multi-literal calls become
  `Literals([...])`.
- Preserve union member order. The v4 union tests members in array order and returns the first match.

## Codemod rule

The array/positional constructor rewrites are mechanical after checking arity. `optionalWith`,
boolean filters, refinements, nullable fields, and defaults require per-site review and differential
fixtures.
