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
).annotate({ [width]: 'f32' }).pipe(
  Schema.decodeTo(
    Schema.Finite.check(
      Schema.makeFilter<number>((value) => Number.isFinite(Math.fround(value)), {
        expected: 'finite binary32 value',
      }),
    ),
    SchemaTransformation.transform({ decode: Math.fround, encode: Math.fround }),
  ),
)

/** Recognition uses the registered transformation, never width metadata alone. */
export const isF32AST = (ast: SchemaAST.AST): boolean =>
  ast._tag === 'Number' && ast.encoding === F32.ast.encoding && ast.checks === F32.ast.checks

export { pattern, assertPortablePattern } from './pattern.ts'
