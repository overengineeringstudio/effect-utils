/**
 * Vitest setup file that installs the gate's project annotations.
 *
 * Referenced by `createStoryGateProject` as `test.setupFiles`; never imported
 * from Node.
 *
 * @module
 */

import { setProjectAnnotations } from 'storybook/internal/preview-api'
// oxlint-disable-next-line import/no-unresolved -- emitted by the Storybook Vite builder that `storybookTest` installs.
import { getProjectAnnotations } from 'virtual:/@storybook/builder-vite/project-annotations.js'
import { beforeAll } from 'vitest'

import { storyGateAnnotations } from './annotations.ts'

/**
 * `setProjectAnnotations` replaces rather than merges, and the Storybook Vitest
 * addon calls it at module scope from its own setup file. Setup-file ordering
 * between the addon's injected entries and ours is decided by Vite's config
 * merge and is not ours to control — but every setup module is evaluated before
 * any hook runs, so re-composing from `beforeAll` puts the gate's layer last
 * regardless of that order.
 */
beforeAll(() => {
  const base = getProjectAnnotations()
  setProjectAnnotations([...(Array.isArray(base) === true ? base : [base]), storyGateAnnotations])
})
