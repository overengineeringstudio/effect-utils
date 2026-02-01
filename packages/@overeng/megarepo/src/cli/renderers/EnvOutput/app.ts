/**
 * EnvOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { EnvState, EnvAction, envReducer } from './schema.ts'

/**
 * Initial empty state for env output.
 */
export const createInitialEnvState = (): typeof EnvState.Type => ({
  MEGAREPO_ROOT_OUTERMOST: '',
  MEGAREPO_ROOT_NEAREST: '',
  MEGAREPO_MEMBERS: '',
  shell: 'bash',
})

/**
 * TuiApp for env output.
 */
export const EnvApp = createTuiApp({
  stateSchema: EnvState,
  actionSchema: EnvAction,
  initial: createInitialEnvState(),
  reducer: envReducer,
  exitCode: (state) => ('error' in state ? 1 : 0),
})
