# Pattern: schema-transformations-issues

**Area:** Schema transformations and parse issues **Kind:** shape change **Our usage:** 27
`ParseResult` references in 15 files across 7 packages, plus transformation and filter callbacks
inside the 640-reference Schema constructor/options surface.

## Shape change first

V3 fallible transformation callbacks returned `ParseResult` effects and received the transformation
AST as a callback argument. V4 separates the concerns:

- `Schema.decodeTo` connects the encoded/source schema to the decoded/target schema.
- `SchemaTransformation.transform` describes a pure bidirectional conversion.
- `SchemaTransformation.transformOrFail` describes an effectful conversion whose failure is a
  `SchemaIssue.Issue`.
- `SchemaIssue` replaces the old parse-issue constructors and formatters.

All three modules are exported from the `effect` root at `4.0.0-beta.102`.

## Pure transformations

### v3

```ts
const NumberFromString = Schema.transform(Schema.String, Schema.Number, {
  strict: true,
  decode: Number,
  encode: String,
})
```

### v4

```ts
import { Schema, SchemaTransformation } from 'effect'

const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({
      decode: Number,
      encode: String,
    }),
  ),
)
```

The source schema is piped into `decodeTo`; the target schema is its first argument. The old `strict`
option is not copied.

### The transformation targets `To["Encoded"]`

`Schema.decodeTo(To, transformation)` requires the transformation's decoded output to be
`To["Encoded"]`, not `To["Type"]`. The target codec then decodes that encoded representation.
Examples such as `NumberFromString`, where the target's `Type` and `Encoded` are both `number`, do
not exercise this distinction.

For a transformed target codec, produce its encoded representation by using the target's encoder
instead of rebuilding its decoded value:

```ts
const Users = Schema.Array(User)
const encodeUsers = Schema.encodeSync(Users)

const People = PeopleProperty.pipe(
  Schema.decodeTo(
    Users,
    SchemaTransformation.transform<typeof Users.Encoded, typeof PeopleProperty.Type>({
      decode: (property) => encodeUsers(property.people),
      encode: (_users): typeof PeopleProperty.Type => {
        throw new Error('This codec only supports decoding')
      },
    }),
  ),
)
```

This contract is **VERIFIED** against the beta.102 `Schema.decodeTo` declaration. For transformed
targets, typechecking is not sufficient: replay exact encoded bytes, especially for optional fields
whose absent representation may be omitted or encoded as `null`.

### Decode-only pure transformations

When an unsupported encode callback only throws, its inferred return type is `never`. Do not leave
the transformation's encoded type to inference: state both transformation types and annotate the
throwing callback's return type.

```ts
const DecodeOnly = Schema.String.pipe(
  Schema.decodeTo(
    Target,
    SchemaTransformation.transform<TargetType, string>({
      decode: (input) => decodeInput(input),
      encode: (_value): string => {
        throw new Error('This codec only supports decoding')
      },
    }),
  ),
)
```

This explicit form is **VERIFIED** to compile against the
`effect@4.0.0-beta.102` declarations and retains the encoded `string` contract. Prefer
`transformOrFail` with a `SchemaIssue.Forbidden` failure when the old codec represented unsupported
encoding in the typed error channel. Whether throwing or typed failure is faithful depends on the
v3 call site; do not change that boundary merely to satisfy inference.

One-directional codecs with deliberately throwing encoders are legitimate existing contracts. A
successful encode can be a regression when the old boundary intentionally rejected that direction;
preserve the throw and prove only the supported direction.

## Fallible transformations and issues

### v3

```ts
const Parsed = Schema.transformOrFail(Schema.String, Schema.Unknown, {
  strict: true,
  decode: (text, _options, ast) =>
    ParseResult.try({
      try: () => parse(text),
      catch: (cause) => new ParseResult.Type(ast, text, String(cause)),
    }),
  encode: (value) => ParseResult.succeed(format(value)),
})
```

### v4

```ts
import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from 'effect'

const Parsed = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transformOrFail({
      decode: (text) =>
        Effect.try({
          try: () => parse(text),
          catch: (cause) =>
            new SchemaIssue.InvalidValue(Option.some(text), {
              message: String(cause),
            }),
        }),
      encode: (value) => Effect.succeed(format(value)),
    }),
  ),
)
```

The v4 callback failure must be an `Issue`, not `SchemaError` and not an old `ParseResult.ParseError`.
When the offending value is known, pass `Option.some(value)`; use `Option.none()` only when it is
genuinely absent.

## Issue migration

| v3 callback form                                   | v4 callback form                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `ParseResult.succeed(value)`                       | `Effect.succeed(value)`                                          |
| `ParseResult.fail(issue)`                          | `Effect.fail(issue)`                                             |
| `ParseResult.try({ try, catch })`                  | `Effect.try({ try, catch })`, with `catch` returning an `Issue`  |
| `new ParseResult.Type(ast, actual, message)`       | `new SchemaIssue.InvalidValue(Option.some(actual), { message })` |
| `new ParseResult.Forbidden(ast, actual, message)`  | `new SchemaIssue.Forbidden(Option.some(actual), { message })`    |
| `ParseResult.TreeFormatter.formatIssueSync(issue)` | `SchemaIssue.makeFormatterDefault()(issue)`                      |

Do not preserve the old `ast` parameter by manufacturing an AST. `InvalidValue` and `Forbidden`
carry the actual value and annotations directly. Use richer `SchemaIssue` nodes only when their
structure is observable and verified by the slice.

## Filters and refinements

A validation-only callback does not need a transformation:

```ts
const Positive = Schema.Number.check(Schema.makeFilter((value) => value > 0 || 'must be positive'))
```

Use `Schema.refine(typeGuard)` when the callback narrows the TypeScript type. `makeFilter` can return
a string, a `SchemaIssue.Issue`, `{ path, issue }`, or an array of issues when error structure must be
preserved.

### Filter messages are no longer lazy

V3 filter/refinement annotations accepted `message: () => string`. Beta.102
`Annotations.Filter.message` is a plain `string`; there is no lazy annotation form. This is
**VERIFIED** from the beta.102 declaration.

For the repository's closures that return a constant string, preserve the text as a constant:

```ts
// v3
Schema.filter(predicate, { message: () => 'must be valid' })

// v4
Schema.refine(predicate, { message: 'must be valid' })
```

Do not mechanically invoke a stateful or expensive closure while constructing the schema. That
changes evaluation from failure-time to schema-construction-time. If narrowing is not required, a
lazy failure string can instead be produced by the check itself:

```ts
Schema.check(Schema.makeFilter((value) => predicate(value) || message()))
```

That form does not preserve a type-guard narrowing. A stateful/expensive type-guard message
therefore needs explicit design review; beta.102 has no direct replacement that preserves both
narrowing and lazy message evaluation.

## Affected inventory

The AST audit measured 27 `ParseResult` references in 15 files and 7 packages. The namespace-member
heatmap identifies the densest callback owners as:

| Package          | Wave | Namespace-member references |
| ---------------- | ---: | --------------------------: |
| `kdl-effect`     |    3 |                           6 |
| `otel-contract`  |    3 |                           5 |
| `restate-effect` |    5 |                           3 |

Direct imports and type-only references account for the remainder of the headline inventory. Pure
`transform`, `transformOrFail`, boolean-filter, and refinement sites are also represented in the
broader 640-reference Schema constructor/options inventory.

## Equivalence

No repository migration is applied by this recipe. Each slice must compare:

1. decoded values;
2. exact encoded bytes;
3. success versus failure;
4. issue path and message at observable boundaries; and
5. whether a supposedly synchronous codec still requires an effectful adapter.

Do not silently rebaseline parse messages. If v4 formatting differs, preserve or normalize the
boundary text, or record an explicit alignment decision.

Every v4 symbol in this recipe was checked against the `effect@4.0.0-beta.102` npm tarball with
SHA-1 `f51092854960f60cbdb06bd59e788acbc8ee8492`.

## Gotchas

- `SchemaTransformation.transform` is only for pure, infallible conversions. Returning an `Effect`
  from it creates the wrong decoded value.
- Give decode-only pure transformations explicit `<Type, Encoded>` parameters and an encoded return
  annotation on a throwing callback; otherwise `never` can erase the intended direction.
- `SchemaTransformation.transformOrFail` callbacks return `Effect`; throwing bypasses the typed issue
  channel.
- `Schema.decodeUnknownEffect` exposes `SchemaError`, while transformation callbacks operate on
  `SchemaIssue.Issue`.
- A formatter rewrite can change user-visible text even when decoding behavior is otherwise
  equivalent.
- V4 filter annotation messages are eager strings. Only constant closures can be collapsed without
  a timing/value review.

## Codemod rule

None. The outer `transform*` syntax is predictable, but callback failure construction, formatting,
and observable issue paths require per-site review.
