import { type TuiApp, createTuiApp } from '@overeng/tui-react'

import { PlanAction, PlanState, initialPlanState, planExitCode, planReducer } from './schema.ts'

let cached: TuiApp<PlanState, PlanAction> | undefined

/**
 * TUI app definition for the read-only `plan` command output.
 *
 * Built lazily (and memoized) rather than at module top level: an eager
 * `createTuiApp` is a module-load side-effect that crashes the umbrella `notion`
 * binary under Bun's concurrent command-tree import (#787, oven-sh/bun#30634).
 * Mirrors `getSyncApp()`; drop the laziness once the Bun fix lands.
 *
 * `initial` carries an empty target placeholder — the handler dispatches the real
 * target (`SetTarget`) and the terminal result; the target label surfaces through
 * the view's `context` header.
 */
export const getPlanApp = (): TuiApp<PlanState, PlanAction> =>
  (cached ??= createTuiApp({
    stateSchema: PlanState,
    actionSchema: PlanAction,
    initial: initialPlanState('') as PlanState,
    reducer: planReducer,
    exitCode: planExitCode,
  }))
