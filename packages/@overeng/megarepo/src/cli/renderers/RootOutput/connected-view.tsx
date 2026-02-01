/**
 * RootOutput Connected View
 *
 * Wraps the pure RootView with atoms for CLI usage.
 * This separation allows the pure view to be used in Storybook and tests.
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { RootApp } from './app.ts'
import { RootView } from './view.tsx'

/**
 * RootConnectedView - Uses atoms to get state.
 *
 * Use this in CLI context where RootApp.run() is active.
 * For Storybook/tests, use RootView directly with state prop.
 */
export const RootConnectedView = () => {
  const state = useTuiAtomValue(RootApp.stateAtom)
  return <RootView state={state} />
}
