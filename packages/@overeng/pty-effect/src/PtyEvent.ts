import { Schema } from 'effect'

import { PtyName } from './PtySpec.ts'

const Tags = Schema.Record({ key: Schema.String, value: Schema.String })

const Base = {
  session: PtyName,
  ts: Schema.String,
}

export const BellEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('bell'),
})
export type BellEvent = typeof BellEvent.Type

export const TitleChangeEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('title_change'),
  value: Schema.String,
})
export type TitleChangeEvent = typeof TitleChangeEvent.Type

export const NotificationEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('notification'),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal('osc9', 'osc99', 'osc777')),
})
export type NotificationEvent = typeof NotificationEvent.Type

export const FocusRequestEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('focus_request'),
})
export type FocusRequestEvent = typeof FocusRequestEvent.Type

export const CursorVisibleEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('cursor_visible'),
})
export type CursorVisibleEvent = typeof CursorVisibleEvent.Type

export const SessionStartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_start'),
  tags: Schema.optional(Tags),
})
export type SessionStartEvent = typeof SessionStartEvent.Type

export const SessionExitEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_exit'),
  exitCode: Schema.Number.pipe(Schema.int()),
})
export type SessionExitEvent = typeof SessionExitEvent.Type

export const SessionRestartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_restart'),
  restartCount: Schema.Number.pipe(Schema.int()),
  backoffMs: Schema.Number.pipe(Schema.int()),
})
export type SessionRestartEvent = typeof SessionRestartEvent.Type

export const SessionFailedEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('session_failed'),
  restartCount: Schema.Number.pipe(Schema.int()),
  reason: Schema.String,
})
export type SessionFailedEvent = typeof SessionFailedEvent.Type

export const SupervisorStartEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('supervisor_start'),
})
export type SupervisorStartEvent = typeof SupervisorStartEvent.Type

export const SupervisorStopEvent = Schema.Struct({
  ...Base,
  type: Schema.Literal('supervisor_stop'),
})
export type SupervisorStopEvent = typeof SupervisorStopEvent.Type

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

export const decodePtyEvent = Schema.decodeUnknownSync(PtyEvent)
