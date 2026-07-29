# Pattern: root import renames

**Area:** Effect root exports / schema parsing / metrics / loader API moves **Kind:** mechanical
root export move with call-shape changes
**Our usage:** `otel-contract` reached all three removed root exports during the flip branch module
load path. The same mappings may clear other current-source tool builds whose Nix/runtime closure
imports `otel-contract`.

The flip branch also rewrote imports from old consolidated packages (`@effect/cli`,
`@effect/platform`) into the `effect` root. Treat those as **Category A rewrite fallout**, not
removed root exports. File count observed in the branch handoff: 165 files out of the 309 changed by
the flip. Do not encode same-named platform symbols as Effect root API changes when beta.102 still
exports them from the root.

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

## Category A: bad consolidated-package root rewrite

These came from package moves, not from root removals:

| v3 package/source | v4 package/source | Notes |
| --- | --- | --- |
| `@effect/cli/Args` | `effect/unstable/cli` `Argument` | Namespace renamed. |
| `@effect/cli/Options` | `effect/unstable/cli` `Flag` | `text()` became `string()`. |
| `@effect/cli/Command` | `effect/unstable/cli` `Command` | Do not import from root. |
| `@effect/cli` namespace | `effect/unstable/cli` namespace | Use `Cli.Argument` / `Cli.Flag`. |
| `@effect/platform/HttpClient*` | `effect/unstable/http` | `HttpClient`, `HttpClientRequest`, `HttpClientResponse`, `HttpClientError`, `FetchHttpClient`. |
| `@effect/platform/Command` | `effect/unstable/process` `ChildProcess` | Existing local alias can preserve call-site name. |
| `@effect/platform/CommandExecutor` | `effect/unstable/process` `ChildProcessSpawner` | Service type is `ChildProcessSpawner.ChildProcessSpawner`. |

`FileSystem`, `Path`, and `PlatformError` are present in beta.102 root exports. If they appear in a
Category A provenance scan, classify them as rewrite audit hazards rather than genuine root removals.

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
      encode: (decoded) => Effect.fail(new SchemaIssue.Forbidden(Option.some(decoded), undefined)),
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
- `@effect/atom-react` is not currently installed in the branch. A full reinstall / `pnpm:repair`
  removes any temporary manual materialization and makes `genie:run` fail there before later loader
  blockers.

## Loader API moves observed after the root-export repairs

These were verified against `effect@4.0.0-beta.102` while chasing `genie:run` module-load blockers.

| v3 shape | beta.102 shape | Notes |
| --- | --- | --- |
| `Schema.NonEmptyTrimmedString` | `Schema.Trimmed.check(Schema.isNonEmpty())` | Value helper removed. |
| `Schema.NonNegativeInt` | `Schema.Natural` | `Schema.Int` still exists; `Natural` is `Int >= 0`. |
| `Schema.NonNegativeBigInt` | `Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n))` | No `NaturalBigInt` export observed. |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` | Same class-style call family. |
| `Schema.Defect` | `Schema.Defect()` | Became a schema factory function. |
| `Schema.parseJson(schema)` | `Schema.fromJsonString(schema)` | Zero-arg form becomes `Schema.fromJsonString(Schema.Unknown)`. Pretty-print options are not carried by this helper. |
| `Schema.maxLength(n)` / `Schema.minLength(n)` | `Schema.check(Schema.isMaxLength(n))` / `Schema.check(Schema.isMinLength(n))` | Filters are not pipe functions by themselves. |
| `Schema.isPattern(re)` in `.pipe(...)` | `Schema.check(Schema.isPattern(re))` | Direct `.check(Schema.isPattern(re))` is already valid. |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` | Existing array calls stay unchanged. |
| `Schema.Tuple(A, B)` | `Schema.Tuple([A, B])` | Existing array calls stay unchanged. |
| `Schema.fromBrand(ctor)(schema)` | `Schema.fromBrand(identifier, ctor)(schema)` | Bare constructor overload removed. |
| `Schema.transform(from, to, options)` | `from.pipe(Schema.decodeTo(to, options))` | For effectful transforms use `SchemaTransformation.transformOrFail(...)`. |
| `SchemaAST.getAnnotation<T>(ast, id)` | `SchemaAST.resolveAt<T>(id)(ast)` | Returns `T | undefined`, not `Option<T>`. |
| `SchemaAST.getAnnotation<T>(id)(ast)` | `SchemaAST.resolveAt<T>(id)(ast)` | Remove `Option.isSome` / `Option.getOrUndefined` wrappers. |
| `Context.Tag("id")<Self, Service>()` | `Context.Service<Self, Service>()("id")` | Class-style service tags. |
| `Logger.prettyLogger()` | `Logger.consolePretty()` | Console pretty logger constructor. |
| `Logger.replace(Logger.defaultLogger, logger)` | `Logger.layer([logger])` | To keep default plus custom logger use `Logger.layer([Logger.defaultLogger, logger])`. |

Known remaining source search after this batch: `Logger.replaceScoped` in browser broadcast logging
was not on the `genie:run` loader path and was not ported in this slice.
