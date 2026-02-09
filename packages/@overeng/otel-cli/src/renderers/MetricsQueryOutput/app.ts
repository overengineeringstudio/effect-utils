/**
 * MetricsQuery TUI app
 *
 * Creates the TuiApp instance for the `otel metrics query` command.
 */

import { createTuiApp } from '@overeng/tui-react'

import { QueryAction, QueryState, createInitialQueryState, queryReducer } from './schema.ts'

/** TUI app for metrics query. */
export const QueryApp = createTuiApp({
  stateSchema: QueryState,
  actionSchema: QueryAction,
  initial: createInitialQueryState(),
  reducer: queryReducer,
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
