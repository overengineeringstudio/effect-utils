import { Schema } from 'effect'

/**
 * Named keys understood by `@myobie/pty`'s `resolveKey`.
 *
 * Keep the literal list aligned with the upstream `keys.ts` table. Any new
 * named key the upstream adds should be added here so it's reachable from
 * the typed `Key` schema rather than via a free string.
 */
export const NamedKey = Schema.Literal(
  'return',
  'enter',
  'tab',
  'escape',
  'esc',
  'space',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
)
export type NamedKey = typeof NamedKey.Type

/**
 * A key spec accepted by `PtySession.press`. Either:
 * - a `NamedKey` (e.g. `"return"`)
 * - a `NamedKey` with one or more modifiers (e.g. `"ctrl+c"`, `"ctrl+shift+left"`)
 * - a single printable character (e.g. `"a"`)
 *
 * Validated as a string at the schema layer; the deeper structure is
 * checked by upstream's `resolveKey` (which throws on unknown specs —
 * we surface that as a `WriteFailed` PtyError).
 */
export const Key = Schema.String.pipe(Schema.minLength(1), Schema.brand('@overeng/pty-effect/Key'))
export type Key = typeof Key.Type

/** Helper to construct a Key from a string literal at call sites. */
export const key = (spec: string): Key => Key.make(spec)
