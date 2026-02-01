/**
 * SyncOutput Connected View
 *
 * Wraps the pure SyncView with atoms for CLI usage.
 * This separation allows the pure view to be used in Storybook and tests.
 */

import React from 'react'

import { useTuiAtomValue } from '@overeng/tui-react'

import { SyncApp } from './app.ts'
import { SyncView } from './view.tsx'

/**
 * SyncConnectedView - Uses atoms to get state.
 *
 * Use this in CLI context where SyncApp.run() is active.
 * For Storybook/tests, use SyncView directly with state prop.
 */
export const SyncConnectedView = () => {
  const state = useTuiAtomValue(SyncApp.stateAtom)
  return <SyncView state={state} />
}
