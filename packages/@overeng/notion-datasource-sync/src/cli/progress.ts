import { Schema } from 'effect'
import React from 'react'

import { Box, Text, createTuiApp, useTuiAtomValue, type TuiApp } from '@overeng/tui-react'

import type { SyncProgressEvent, SyncProgressPhase } from '../core/progress.ts'

const Phase = Schema.Literal(
  'preparing',
  'pulling',
  'querying',
  'hydrating',
  'planning',
  'pushing',
  'executing',
  'projecting',
  'watching',
  'complete',
)

const SyncProgressState = Schema.Struct({
  command: Schema.String,
  phase: Phase,
  message: Schema.String,
  current: Schema.Number,
  total: Schema.optional(Schema.Number),
  pages: Schema.Number,
  rows: Schema.Number,
  executorSteps: Schema.Number,
  requests: Schema.Number,
  rateLimitRemaining: Schema.optional(Schema.Number),
  rateLimitResetAfterSeconds: Schema.optional(Schema.Number),
  retryDelayMs: Schema.optional(Schema.Number),
  httpOperation: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number),
})

export type SyncProgressState = typeof SyncProgressState.Type

const SyncProgressAction = Schema.Union(
  Schema.TaggedStruct('SetState', {
    state: SyncProgressState,
  }),
  Schema.TaggedStruct('ApplyEvent', {
    event: Schema.Any,
  }),
)

export type SyncProgressAction = typeof SyncProgressAction.Type

const initialSyncProgressState = (command: string): SyncProgressState => ({
  command,
  phase: 'preparing',
  message: 'Preparing sync',
  current: 0,
  pages: 0,
  rows: 0,
  executorSteps: 0,
  requests: 0,
})

const phaseProgress: Record<SyncProgressPhase, number> = {
  preparing: 5,
  pulling: 15,
  querying: 25,
  hydrating: 45,
  planning: 60,
  pushing: 70,
  executing: 82,
  projecting: 94,
  watching: 50,
  complete: 100,
}

const messageForPhase = (phase: SyncProgressPhase): string => {
  switch (phase) {
    case 'preparing':
      return 'Preparing sync'
    case 'pulling':
      return 'Pulling from Notion'
    case 'querying':
      return 'Querying Notion rows'
    case 'hydrating':
      return 'Hydrating rows'
    case 'planning':
      return 'Planning local changes'
    case 'pushing':
      return 'Pushing local changes'
    case 'executing':
      return 'Executing remote writes'
    case 'projecting':
      return 'Projecting SQLite replica'
    case 'watching':
      return 'Watching for changes'
    case 'complete':
      return 'Sync complete'
  }
}

const applyProgressEvent = ({
  state,
  event,
}: {
  readonly state: SyncProgressState
  readonly event: SyncProgressEvent
}): SyncProgressState => {
  switch (event._tag) {
    case 'phase':
      return {
        ...state,
        phase: event.phase,
        message: event.message ?? messageForPhase(event.phase),
        current: Math.max(state.current, phaseProgress[event.phase]),
        ...(event.phase === 'complete' ? { total: 100 } : {}),
      }
    case 'query-page':
      return {
        ...state,
        phase: 'querying',
        message: event.hasMore === true ? 'Querying Notion rows' : 'Query complete',
        current: Math.max(state.current, phaseProgress.querying),
        pages: event.pages,
        rows: event.rows,
      }
    case 'hydrate-row': {
      const ratio = event.total <= 0 ? 1 : event.current / event.total
      return {
        ...state,
        phase: 'hydrating',
        message: `Hydrating rows ${event.current}/${event.total}`,
        current: Math.max(state.current, Math.round(phaseProgress.hydrating + ratio * 15)),
        total: event.total,
      }
    }
    case 'executor-step':
      return {
        ...state,
        phase: 'executing',
        message:
          event.result === 'idle'
            ? 'Remote writes drained'
            : `Executing remote writes ${event.current}/${event.max}`,
        current: Math.max(state.current, phaseProgress.executing),
        executorSteps: event.current,
      }
    case 'rate-limit':
      return {
        ...state,
        message:
          event.retryDelayMs === undefined
            ? state.message
            : `Rate limited; retrying in ${Math.ceil(event.retryDelayMs / 1000)}s`,
        requests: state.requests + event.requestCount,
        rateLimitRemaining: event.remaining,
        rateLimitResetAfterSeconds: event.resetAfterSeconds,
        retryDelayMs: event.retryDelayMs,
        httpOperation: `${event.method} ${event.operation}`,
        httpStatus: event.status,
      }
  }
}

/** Stateful TUI app contract for sync progress rendering. */
export type SyncProgressApp = TuiApp<SyncProgressState, SyncProgressAction>

/** Creates the sync progress state machine for one CLI command. */
export const createSyncProgressApp = (command: string): SyncProgressApp =>
  createTuiApp<SyncProgressState, SyncProgressAction>({
    stateSchema: SyncProgressState,
    actionSchema: SyncProgressAction,
    initial: initialSyncProgressState(command),
    reducer: ({ state, action }) => {
      switch (action._tag) {
        case 'SetState':
          return action.state
        case 'ApplyEvent':
          return applyProgressEvent({
            state,
            event: action.event as SyncProgressEvent,
          })
      }
    },
  })

const h = React.createElement

const ProgressBar = ({
  current,
  width = 28,
}: {
  readonly current: number
  readonly width?: number
}) => {
  const bounded = Math.max(0, Math.min(100, current))
  const filled = Math.round((bounded / 100) * width)
  return h(
    Box,
    { flexDirection: 'row' },
    h(Text, { color: 'green' }, '#'.repeat(filled)),
    h(Text, { dim: true }, '-'.repeat(width - filled)),
    h(Text, null, ` ${bounded}%`),
  )
}

/** Renders the sync progress TUI for a running progress app. */
export const createSyncProgressView = (
  app: ReturnType<typeof createSyncProgressApp>,
): React.ReactElement => {
  const View = () => {
    const state = useTuiAtomValue(app.stateAtom)
    const details = [
      state.rows > 0 ? `${state.rows} rows` : undefined,
      state.pages > 0 ? `${state.pages} pages` : undefined,
      state.requests > 0 ? `${state.requests} requests` : undefined,
      state.rateLimitRemaining === undefined
        ? undefined
        : `${state.rateLimitRemaining} quota remaining`,
      state.rateLimitResetAfterSeconds === undefined || state.rateLimitResetAfterSeconds <= 0
        ? undefined
        : `reset ${state.rateLimitResetAfterSeconds}s`,
      state.httpOperation === undefined
        ? undefined
        : `${state.httpOperation}${state.httpStatus === undefined ? '' : ` ${state.httpStatus}`}`,
      state.executorSteps > 0 ? `${state.executorSteps} write steps` : undefined,
    ].filter((item): item is string => item !== undefined)

    return h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { bold: true }, 'notion-datasource-sync '),
        h(Text, { color: state.phase === 'complete' ? 'green' : 'cyan' }, state.command),
        h(Text, { dim: true }, ` ${state.phase}`),
      ),
      h(ProgressBar, { current: state.current }),
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, null, state.message),
        details.length > 0 ? h(Text, { dim: true }, ` · ${details.join(' · ')}`) : null,
      ),
    )
  }

  return h(View)
}
