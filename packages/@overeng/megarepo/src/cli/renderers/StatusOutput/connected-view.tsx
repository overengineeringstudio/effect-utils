/**
 * StatusOutput Connected View
 *
 * Wraps the pure StatusView with atoms for CLI usage.
 * This separation allows the pure view to be used in Storybook and tests.
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { StatusApp } from './app.ts'
import { StatusView } from './view.tsx'

/**
 * StatusConnectedView - Uses atoms to get state.
 *
 * Use this in CLI context where StatusApp.run() is active.
 * For Storybook/tests, use StatusView directly with state prop.
 */
export const StatusConnectedView = () => {
  const state = useTuiAtomValue(StatusApp.stateAtom)
  return <StatusView state={state} />
}
