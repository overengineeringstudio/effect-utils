/**
 * SyncApp - createTuiApp-based Sync Progress
 *
 * Replaces the TuiRenderer + SubscriptionRef pattern with the createTuiApp factory.
 * Provides schema-validated state, typed actions, and built-in output mode support.
 *
 * @module
 */

import { Schema } from 'effect'
import React, { useMemo } from 'react'

import {
  Box,
  Text,
  Static,
  TaskList,
  createTuiApp,
  type TaskItem,
  type TaskStatus,
} from '@overeng/tui-react'

// =============================================================================
// Schema Definitions
// =============================================================================

/** Status of a sync item */
export const SyncItemStatus = Schema.Literal('pending', 'active', 'success', 'error', 'skipped')
export type SyncItemStatus = typeof SyncItemStatus.Type

/** A single sync item */
export const SyncItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: SyncItemStatus,
  message: Schema.optional(Schema.String),
  data: Schema.optional(
    Schema.Struct({
      ref: Schema.optional(Schema.String),
      commit: Schema.optional(Schema.String),
    }),
  ),
})
export type SyncItem = typeof SyncItem.Type

/** A log entry */
export const SyncLogEntry = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('info', 'warn', 'error'),
  message: Schema.String,
})
export type SyncLogEntry = typeof SyncLogEntry.Type

/** Complete sync progress state */
export const SyncProgressState = Schema.Struct({
  /** Workspace name */
  title: Schema.String,
  /** Workspace root path */
  subtitle: Schema.optional(Schema.String),
  /** Active modes (dry run, frozen, pull, deep) */
  modes: Schema.optional(Schema.Array(Schema.String)),
  /** All sync items */
  items: Schema.Array(SyncItem),
  /** Log entries */
  logs: Schema.Array(SyncLogEntry),
  /** Start time for elapsed calculation */
  startTime: Schema.Number,
  /** Whether sync is complete */
  isComplete: Schema.Boolean,
  /** Optional metadata */
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})
export type SyncProgressState = typeof SyncProgressState.Type

/** Actions that modify sync progress state */
export const SyncProgressAction = Schema.Union(
  // Initialize with items
  Schema.TaggedStruct('Init', {
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
      }),
    ),
    metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  }),
  // Set item status
  Schema.TaggedStruct('SetItemStatus', {
    id: Schema.String,
    status: SyncItemStatus,
    message: Schema.optional(Schema.String),
    data: Schema.optional(
      Schema.Struct({
        ref: Schema.optional(Schema.String),
        commit: Schema.optional(Schema.String),
      }),
    ),
  }),
  // Add a log entry
  Schema.TaggedStruct('AddLog', {
    type: Schema.Literal('info', 'warn', 'error'),
    message: Schema.String,
  }),
  // Mark sync as complete
  Schema.TaggedStruct('SetComplete', {}),
  // Handle Ctrl+C interruption
  Schema.TaggedStruct('Interrupted', {}),
)
export type SyncProgressAction = typeof SyncProgressAction.Type

// =============================================================================
// Reducer
// =============================================================================

let logCounter = 0

export const syncProgressReducer = ({
  state,
  action,
}: {
  state: SyncProgressState
  action: SyncProgressAction
}): SyncProgressState => {
  switch (action._tag) {
    case 'Init':
      return {
        ...state,
        items: action.items.map((item) => ({
          id: item.id,
          label: item.label,
          status: 'pending' as const,
        })),
        metadata: action.metadata,
        startTime: Date.now(),
        isComplete: false,
      }

    case 'SetItemStatus':
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.id
            ? {
                ...item,
                status: action.status,
                message: action.message,
                data: action.data ?? item.data,
              }
            : item,
        ),
      }

    case 'AddLog':
      return {
        ...state,
        logs: [
          ...state.logs,
          {
            id: `log-${++logCounter}`,
            type: action.type,
            message: action.message,
          },
        ],
      }

    case 'SetComplete':
      return { ...state, isComplete: true }

    case 'Interrupted':
      // On interrupt, mark any active items as skipped
      return {
        ...state,
        items: state.items.map((item) =>
          item.status === 'active'
            ? { ...item, status: 'skipped' as const, message: 'interrupted' }
            : item,
        ),
        isComplete: true,
      }
  }
}

// =============================================================================
// Initial State Factory
// =============================================================================

export const createInitialState = (options: {
  title: string
  subtitle?: string
  modes?: readonly string[]
}): SyncProgressState => ({
  title: options.title,
  ...(options.subtitle !== undefined ? { subtitle: options.subtitle } : {}),
  ...(options.modes !== undefined ? { modes: options.modes } : {}),
  items: [],
  logs: [],
  startTime: Date.now(),
  isComplete: false,
})

// =============================================================================
// App Definition
// =============================================================================

/**
 * Create a SyncApp instance.
 *
 * We create the app lazily to allow different initial states per invocation.
 */
export const createSyncApp = (initialState: SyncProgressState) =>
  createTuiApp({
    stateSchema: SyncProgressState,
    actionSchema: SyncProgressAction,
    initial: initialState,
    reducer: syncProgressReducer,
    interruptTimeout: 300,
  })

/** Type for the SyncApp */
export type SyncApp = ReturnType<typeof createSyncApp>

// =============================================================================
// View Components
// =============================================================================

/**
 * Sync progress view component.
 * Takes state directly (used with createTuiApp).
 */
export const SyncProgressView = ({ state }: { state: SyncProgressState }) => {
  const taskItems: TaskItem[] = useMemo(
    () =>
      state.items.map((item) => ({
        id: item.id,
        label: item.label,
        status: mapStatus(item.status),
        message: item.message,
      })),
    [state.items],
  )

  return (
    <>
      {/* Static region: logs */}
      <Static items={state.logs}>
        {(log: SyncLogEntry) => <LogLine key={log.id} log={log} />}
      </Static>

      {/* Dynamic region */}
      <Box paddingTop={state.logs.length > 0 ? 1 : 0}>
        <Header title={state.title} subtitle={state.subtitle} modes={state.modes} />
        <TaskList items={taskItems} />
        {!state.isComplete && <Summary items={state.items} />}
        {state.isComplete && (
          <Box paddingTop={1}>
            <Text color="green" bold>
              Done
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}

/**
 * Connected view that uses app-scoped useState hook.
 * Must be rendered within SyncApp.run().
 */
export const createConnectedView = (app: SyncApp) => {
  const ConnectedSyncProgressView = () => {
    const state = app.useState()
    return <SyncProgressView state={state} />
  }
  return ConnectedSyncProgressView
}

// =============================================================================
// Internal Helpers
// =============================================================================

function mapStatus(status: SyncItemStatus): TaskStatus {
  return status
}

function LogLine({ log }: { log: SyncLogEntry }) {
  const color = log.type === 'error' ? 'red' : log.type === 'warn' ? 'yellow' : 'cyan'
  const prefix = log.type === 'error' ? '!' : log.type === 'warn' ? '!' : 'i'

  return (
    <Box flexDirection="row">
      <Text color={color}>[{prefix}]</Text>
      <Text dim> {log.message}</Text>
    </Box>
  )
}

function Header({
  title,
  subtitle,
  modes,
}: {
  title: string
  subtitle: string | undefined
  modes: readonly string[] | undefined
}) {
  return (
    <Box>
      <Text bold>{title}</Text>
      {subtitle && <Text dim> {subtitle}</Text>}
      {modes && modes.length > 0 && <Text dim> mode: {modes.join(', ')}</Text>}
      <Text> </Text>
    </Box>
  )
}

function Summary({ items }: { items: readonly SyncItem[] }) {
  const counts = useMemo(() => {
    let success = 0
    let error = 0
    let skipped = 0
    for (const item of items) {
      if (item.status === 'success') success++
      else if (item.status === 'error') error++
      else if (item.status === 'skipped') skipped++
    }
    return { completed: success + error + skipped, error }
  }, [items])

  return (
    <Box paddingTop={1}>
      <Text dim>
        {counts.completed}/{items.length}
        {counts.error > 0 && (
          <Text color="red">
            {' '}
            · {counts.error} error{counts.error > 1 ? 's' : ''}
          </Text>
        )}
      </Text>
    </Box>
  )
}
