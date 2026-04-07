import { Schema } from 'effect'

import { PtyName } from './PtySpec.ts'

/**
 * Pty session events emitted by upstream's `EventFollower`.
 *
 * Status: defined for forward compatibility. `@myobie/pty` 0.4.1 does not
 * yet expose `EventFollower` via its package `exports` map. Once a future
 * upstream release re-exports it, `PtySession.events` will materialize as
 * `Stream<PtyEvent, PtyError>` using these schemas.
 *
 * TODO(myobie/pty#7): wire `events` once upstream ships `EventFollower`.
 * TODO(myobie/pty#6): blocked on `./client` subpath exposure.
 *
 * The shapes mirror upstream's `EventRecord` union one-to-one so that the
 * eventual wiring is a thin `Schema.decodeUnknown(PtyEvent)` over the
 * upstream payload — no field renames, no surprises.
 */

const Base = {
  session: PtyName,
  /** ISO8601 timestamp emitted by upstream. */
  ts: Schema.String,
}

/** Terminal bell (BEL / `\x07`). */
export class BellEvent extends Schema.TaggedClass<BellEvent>('@overeng/pty-effect/BellEvent')(
  'Bell',
  Base,
) {}

/** Window title change (OSC 0/1/2). */
export class TitleChangeEvent extends Schema.TaggedClass<TitleChangeEvent>(
  '@overeng/pty-effect/TitleChangeEvent',
)('TitleChange', {
  ...Base,
  value: Schema.String,
}) {}

/** OS-level notification request (OSC 9 / 99 / 777). */
export class NotificationEvent extends Schema.TaggedClass<NotificationEvent>(
  '@overeng/pty-effect/NotificationEvent',
)('Notification', {
  ...Base,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal('osc9', 'osc99', 'osc777')),
}) {}

/** Application requested window focus. */
export class FocusRequestEvent extends Schema.TaggedClass<FocusRequestEvent>(
  '@overeng/pty-effect/FocusRequestEvent',
)('FocusRequest', Base) {}

/** Cursor visibility toggled (DECTCEM). */
export class CursorVisibleEvent extends Schema.TaggedClass<CursorVisibleEvent>(
  '@overeng/pty-effect/CursorVisibleEvent',
)('CursorVisible', {
  ...Base,
  visible: Schema.Boolean,
}) {}

/** Tagged union of all pty events. */
export const PtyEvent = Schema.Union(
  BellEvent,
  TitleChangeEvent,
  NotificationEvent,
  FocusRequestEvent,
  CursorVisibleEvent,
)
export type PtyEvent = typeof PtyEvent.Type
