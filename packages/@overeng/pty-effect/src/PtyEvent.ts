import { Schema } from 'effect'

import { PtyName } from './PtySpec.ts'

const Tags = Schema.Record({ key: Schema.String, value: Schema.String })

const Base = {
  session: PtyName,
  ts: Schema.String,
}

/** Terminal bell notification emitted by PTY. */
export const BellEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('bell'),
})
export type BellEvent = typeof BellEvent.Type

/** Terminal title change emitted by PTY. */
export const TitleChangeEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('title_change'),
  value: Schema.String,
})
export type TitleChangeEvent = typeof TitleChangeEvent.Type

/** OSC-based desktop notification emitted by PTY. */
export const NotificationEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('notification'),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal('osc9', 'osc99', 'osc777')),
})
export type NotificationEvent = typeof NotificationEvent.Type

/** Request for the terminal window to take focus. */
export const FocusRequestEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('focus_request'),
})
export type FocusRequestEvent = typeof FocusRequestEvent.Type

/** Cursor visibility toggle emitted by PTY. */
export const CursorVisibleEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('cursor_visible'),
})
export type CursorVisibleEvent = typeof CursorVisibleEvent.Type

/** Session lifecycle start event, including persisted tags when present. */
export const SessionStartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_start'),
  tags: Schema.optional(Tags),
})
export type SessionStartEvent = typeof SessionStartEvent.Type

/** Session exit event with the final child exit code. */
export const SessionExitEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_exit'),
  exitCode: Schema.Number.pipe(Schema.int()),
})
export type SessionExitEvent = typeof SessionExitEvent.Type

/** Session restart event emitted by PTY supervision. */
export const SessionRestartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_restart'),
  restartCount: Schema.Number.pipe(Schema.int()),
  backoffMs: Schema.Number.pipe(Schema.int()),
})
export type SessionRestartEvent = typeof SessionRestartEvent.Type

/** Session failure event emitted after PTY gives up restarting. */
export const SessionFailedEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_failed'),
  restartCount: Schema.Number.pipe(Schema.int()),
  reason: Schema.String,
})
export type SessionFailedEvent = typeof SessionFailedEvent.Type

/** Supervisor lifecycle start event. */
export const SupervisorStartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('supervisor_start'),
})
export type SupervisorStartEvent = typeof SupervisorStartEvent.Type

/** Supervisor lifecycle stop event. */
export const SupervisorStopEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('supervisor_stop'),
})
export type SupervisorStopEvent = typeof SupervisorStopEvent.Type

/** Union of every structured PTY event exposed by the client wrapper. */
export const PtyEvent = Schema.Union(
  BellEvent,
  TitleChangeEvent,
  NotificationEvent,
  FocusRequestEvent,
  CursorVisibleEvent,
  SessionStartEvent,
  SessionExitEvent,
  SessionRestartEvent,
  SessionFailedEvent,
  SupervisorStartEvent,
  SupervisorStopEvent,
)
export type PtyEvent = typeof PtyEvent.Type

/** Decode a raw upstream event payload into the typed PTY event union. */
export const decodePtyEvent = Schema.decodeUnknownSync(PtyEvent)
