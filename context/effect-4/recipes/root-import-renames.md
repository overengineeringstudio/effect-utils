# Pattern: root import renames

**Area:** Effect root exports / schema parsing / metrics **Kind:** mechanical root export move with
call-shape changes
**Our usage:** `otel-contract` reached all three removed root exports during the flip branch module
load path. The same mappings may clear other current-source tool builds whose Nix/runtime closure
imports `otel-contract`.

## v3

```ts
import { Either, MetricBoundaries, ParseResult } from 'effect'
```

## v4

```ts
import { Metric, Result, SchemaIssue, SchemaParser, SchemaTransformation } from 'effect'
```

The exact mappings for `effect@4.0.0-beta.102` are:

```text
Either           -> Result
ParseResult      -> SchemaIssue + SchemaParser
MetricBoundaries -> Metric.boundariesFromIterable / Metric.linearBoundaries / Metric.exponentialBoundaries
```

## Mapping details

### Either -> Result

`Result` is the beta.102 data-success/data-failure successor. It is still a root export, but its
constructors, guards, and property names are not the old `Either` spellings:

```ts
Either.right(value)       -> Result.succeed(value)
Either.left(error)        -> Result.fail(error)
Either.isRight(result)    -> Result.isSuccess(result)
Either.mapLeft(result, f) -> Result.mapError(result, f)
either.right              -> result.success
either.left               -> result.failure
```

## ParseResult split

`ParseResult` split into two namespaces:

- `SchemaParser` owns parse functions such as `decodeUnknownEffect`, `decodeUnknownResult`, and
  `decodeResult`.
- `SchemaIssue` owns issue/error values such as `InvalidValue`, `Forbidden`, `Encoding`, and
  `defaultFormatter`.

Do not map every `ParseResult.*` member to one namespace. Check each member at the call site.

Effectful transformations also moved shape. The old `Schema.transformOrFail(from, to, options)` call
site becomes a schema link:

```ts
From.pipe(
  Schema.decodeTo(
    To,
    SchemaTransformation.transformOrFail({
      decode: (encoded) => SchemaParser.decodeUnknownEffect(To)(encoded),
      encode: (decoded) => Effect.fail(new SchemaIssue.Forbidden(Option.some(decoded))),
    }),
  ),
)
```

## MetricBoundaries trap

`MetricBoundaries` was a namespace in v3. In beta.102 it is not a root export, and this is not only
an import-specifier rewrite. The replacement is functions on `Metric`, and metric constructors also
take an options object:

```ts
Metric.histogram(name, MetricBoundaries.fromIterable(boundaries), description)
```

becomes:

```ts
Metric.histogram(name, {
  boundaries: Metric.boundariesFromIterable(boundaries),
  description,
})
```

Linear and exponential generated buckets become:

```ts
Metric.linearBoundaries({ start, width, count })
Metric.exponentialBoundaries({ start, factor, count })
```

This trap can pass type-oriented greps and still fail at runtime because the old namespace no longer
exists and the histogram call shape changed.

## Intended differences

None. These are beta.102 API moves. Preserve existing decoding, encoding, and metric boundary
semantics unless a separate slice records and proves a behavior change.

## Gotchas

- `Result` uses `_tag: "Success" | "Failure"` and `.success` / `.failure`, not `Right` / `Left`.
- `Schema.decodeUnknownResult` wraps parser issues as `Schema.SchemaError`; use `SchemaParser` when
  the transformation itself must fail with `SchemaIssue.Issue`.
- `Metric.boundariesFromIterable` is the direct replacement for the old explicit-boundaries helper.
  Use `linearBoundaries` and `exponentialBoundaries` only for generated bucket sequences.
- This mapping explains the earlier census result where `ci-tools` was red because its shell
  realization reached `otel-contract`.
