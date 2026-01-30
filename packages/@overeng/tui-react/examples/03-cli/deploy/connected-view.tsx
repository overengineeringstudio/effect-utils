/**
 * Deploy CLI Connected View
 *
 * Wraps the pure DeployView with app-scoped hooks for CLI usage.
 * This separation allows the pure view to be used in Storybook and tests.
 */

import React from 'react'

import { DeployApp } from './deploy.tsx'
import { DeployView } from './view.tsx'

/**
 * ConnectedDeployView - Uses app-scoped hooks to get state.
 *
 * Use this in CLI context where DeployApp.run() is active.
 * For Storybook/tests, use DeployView directly with state prop.
 */
export const ConnectedDeployView = () => {
  const state = DeployApp.useState()
  return <DeployView state={state} />
}
