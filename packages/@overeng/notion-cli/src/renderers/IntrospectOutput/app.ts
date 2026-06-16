import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { IntrospectState, IntrospectAction, introspectReducer } from './schema.ts'

let cached: TuiApp<IntrospectState, IntrospectAction> | undefined

/**
 * TUI app definition for the database introspection command.
 *
 * Constructed lazily (and memoized) rather than at module top level: building it
 * eagerly is a module-load side-effect that crashes the umbrella `notion` binary
 * under Bun's concurrent command-tree import (#787).
 */
export const getIntrospectApp = (): TuiApp<IntrospectState, IntrospectAction> =>
  (cached ??= createTuiApp({
    stateSchema: IntrospectState,
    actionSchema: IntrospectAction,
    initial: { _tag: 'Loading' } as IntrospectState,
    reducer: introspectReducer,
    exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
  }))
