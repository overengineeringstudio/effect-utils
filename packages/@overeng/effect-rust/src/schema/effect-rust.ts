/** Optional storage pin. Changing the inferred or pinned frame width requires a version bump. */
export const width = 'effect-rust/width'
/** DateTimeUtc contract precision; the supported value is `millis`. */
export const timestampPrecision = 'effect-rust/timestampPrecision'
/** Per-object excess property policy (`error` by default, or explicit `ignore`). */
export const excess = 'effect-rust/excess'
/** Marks generated Rust structs and tagged unions as non-exhaustive. */
export const nonExhaustive = 'effect-rust/nonExhaustive'

export { pattern, assertPortablePattern } from './pattern.ts'
