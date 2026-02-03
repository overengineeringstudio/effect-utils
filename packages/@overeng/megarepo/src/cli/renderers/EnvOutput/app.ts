/**
 * EnvOutput TuiApp
 */

import { createTuiApp } from '@overeng/tui-react'

import { EnvState, EnvAction, envReducer } from './schema.ts'

/**
 * Initial empty state for env output.
 */
export const createInitialEnvState = (): typeof EnvState.Type => ({
  _tag: 'Success',
  MEGAREPO_STORE: '',
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
  exitCode: (state) => (state._tag === 'Error' ? 1 : 0),
})
