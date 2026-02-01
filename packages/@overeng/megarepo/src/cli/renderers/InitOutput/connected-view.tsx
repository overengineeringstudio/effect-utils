/**
 * InitOutput Connected View
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { InitApp } from './app.ts'
import { InitView } from './view.tsx'

/**
 * InitConnectedView - Uses atoms to get state.
 */
export const InitConnectedView = () => {
  const state = useTuiAtomValue(InitApp.stateAtom)
  return <InitView state={state} />
}
