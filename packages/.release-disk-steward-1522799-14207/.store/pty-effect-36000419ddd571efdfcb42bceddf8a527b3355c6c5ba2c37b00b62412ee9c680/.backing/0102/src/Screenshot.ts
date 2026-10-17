import { Schema } from 'effect'

/**
 * Captured terminal state at a point in time.
 *
 * Mirrors `@myobie/pty`'s `Screenshot` interface but as a Schema so it can
 * be serialized, validated, and used in property tests.
 */
export const Screenshot = Schema.Struct({
  /** Plain text lines. Trailing whitespace per line is trimmed. Trailing empty lines removed. */
  lines: Schema.Array(Schema.String),
  /** All lines joined with `"\n"`. Convenient for `.includes(...)` checks. */
  text: Schema.String,
  /** Full ANSI-serialized terminal state, including escape codes. */
  ansi: Schema.String,
})
export type Screenshot = typeof Screenshot.Type
