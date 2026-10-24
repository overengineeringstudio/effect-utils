import { Schema, SchemaTransformation } from 'effect'
import type { SchemaAST } from 'effect'

/** Optional storage pin. Changing the inferred or pinned frame width requires a version bump. */
export const width = 'effect-rust/width'
/** DateTimeUtc contract precision; the supported value is `millis`. */
export const timestampPrecision = 'effect-rust/timestampPrecision'
/** Per-object excess property policy (`error` by default, or explicit `ignore`). */
export const excess = 'effect-rust/excess'
/** Marks generated Rust structs and tagged unions as non-exhaustive. */
export const nonExhaustive = 'effect-rust/nonExhaustive'

/** Explicit finite IEEE binary32: numeric input rounds to nearest; overflow fails. */
export const F32 = Schema.Finite.check(
  Schema.makeFilter<number>((value) => Number.isFinite(Math.fround(value)), {
    expected: 'finite binary32 input',
  }),
)
  .annotate({ [width]: 'f32' })
  .pipe(
    Schema.decodeTo(
      Schema.Finite.check(
        Schema.makeFilter<number>((value) => Number.isFinite(Math.fround(value)), {
          expected: 'finite binary32 value',
        }),
      ),
      SchemaTransformation.transform({ decode: Math.fround, encode: Math.fround }),
    ),
  )

const sameCheck = ({
  actual,
  registered,
}: {
  actual: SchemaAST.Check<unknown>
  registered: SchemaAST.Check<unknown>
}): boolean => {
  if (actual === registered) return true
  if (actual._tag === 'Filter' && registered._tag === 'Filter')
    return actual.run === registered.run && actual.aborted === registered.aborted
  if (actual._tag === 'FilterGroup' && registered._tag === 'FilterGroup')
    return sameChecks({ actual: actual.checks, registered: registered.checks })
  return false
}

const sameChecks = ({
  actual,
  registered,
}: {
  actual: readonly SchemaAST.Check<unknown>[] | undefined
  registered: readonly SchemaAST.Check<unknown>[] | undefined
}): boolean =>
  actual === registered ||
  (actual !== undefined &&
    registered !== undefined &&
    actual.length === registered.length &&
    actual.every((check, index) => sameCheck({ actual: check, registered: registered[index]! })))

/**
 * Annotation-only aliases retain the registered encoding and filter behavior.
 * Effect 4 annotate clones the checks array and its last check, preserving run,
 * aborted and nested checks; container identity would reject generated aliases.
 * Width/identifier metadata alone never authorizes a different transformation.
 */
export const isF32AST = (ast: SchemaAST.AST): boolean =>
  ast._tag === 'Number' &&
  ast.encoding === F32.ast.encoding &&
  sameChecks({ actual: ast.checks, registered: F32.ast.checks })

export { pattern, assertPortablePattern } from './pattern.ts'
