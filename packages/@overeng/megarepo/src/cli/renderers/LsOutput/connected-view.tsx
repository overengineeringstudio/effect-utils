/**
 * LsOutput Connected View
 *
 * Wraps the pure LsView with atoms for CLI usage.
 * This separation allows the pure view to be used in Storybook and tests.
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { LsApp } from './app.ts'
import { LsView } from './view.tsx'

/**
 * LsConnectedView - Uses atoms to get state.
 *
 * Use this in CLI context where LsApp.run() is active.
 * For Storybook/tests, use LsView directly with state prop.
 */
export const LsConnectedView = () => {
  const state = useTuiAtomValue(LsApp.stateAtom)
  return <LsView state={state} />
}
