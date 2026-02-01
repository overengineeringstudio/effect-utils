/**
 * EnvOutput Connected View
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { EnvApp } from './app.ts'
import { EnvView } from './view.tsx'

/**
 * EnvConnectedView - Uses atoms to get state.
 */
export const EnvConnectedView = () => {
  const state = useTuiAtomValue(EnvApp.stateAtom)
  return <EnvView state={state} />
}
