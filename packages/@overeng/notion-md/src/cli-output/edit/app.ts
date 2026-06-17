import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { EditAction, EditState, editExitCode, editReducer, initialEditState } from './schema.ts'

let cached: TuiApp<EditState, EditAction> | undefined

/**
 * TUI app definition for the `edit` command output.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors notion-cli's `getDiffApp()`; drop the laziness once the Bun fix lands.
 *
 * `initial` carries an empty page placeholder — the handler dispatches stage
 * transitions and the terminal `SetResult`/`SetError` over the real page; the
 * page label itself comes through the view's `context` header.
 */
export const getEditApp = (): TuiApp<EditState, EditAction> =>
  (cached ??= createTuiApp({
    stateSchema: EditState,
    actionSchema: EditAction,
    initial: initialEditState('') as EditState,
    reducer: editReducer,
    exitCode: editExitCode,
  }))
