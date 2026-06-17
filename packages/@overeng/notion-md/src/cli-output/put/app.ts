import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { PutAction, PutState, initialPutState, putExitCode, putReducer } from './schema.ts'

let cached: TuiApp<PutState, PutAction> | undefined

/**
 * TUI app definition for the `put` command output.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors `getEditApp()`; drop the laziness once the Bun fix lands.
 *
 * `initial` carries an empty page placeholder — the handler dispatches stage
 * transitions and the terminal action over the real page; the page label itself
 * comes through the view's `context` header.
 */
export const getPutApp = (): TuiApp<PutState, PutAction> =>
  (cached ??= createTuiApp({
    stateSchema: PutState,
    actionSchema: PutAction,
    initial: initialPutState('') as PutState,
    reducer: putReducer,
    exitCode: putExitCode,
  }))
