/**
 * Shared fixtures for DumpOutput stories.
 *
 * @internal
 */

import type { DumpState } from './schema.ts'

// =============================================================================
// State Factories
// =============================================================================

/** Creates a Loading state for storybook demos */
export const createLoadingState = (): DumpState => ({
  _tag: 'Loading',
  databaseId: 'abc123',
})

/** Creates an Introspecting state for storybook demos */
export const createIntrospectingState = (): DumpState => ({
  _tag: 'Introspecting',
  databaseId: 'abc123',
})

/** Creates a Fetching state with the given page count */
export const createFetchingState = (pageCount: number): DumpState => ({
  _tag: 'Fetching',
  databaseId: 'abc123',
  dbName: 'Tasks',
  pageCount,
  outputPath: './dump/tasks.json',
})

/** Creates a Done state with optional overrides */
export const createDoneState = (
  overrides: Partial<Extract<DumpState, { _tag: 'Done' }>> = {},
): Extract<DumpState, { _tag: 'Done' }> => ({
  _tag: 'Done',
  pageCount: 150,
  assetsDownloaded: 0,
  assetBytes: 0,
  assetsSkipped: 0,
  failures: 0,
  outputPath: './dump/tasks.json',
  ...overrides,
})

/** Creates an Error state for storybook demos */
export const createErrorState = (): DumpState => ({
  _tag: 'Error',
  message: 'Rate limited by Notion API',
})
