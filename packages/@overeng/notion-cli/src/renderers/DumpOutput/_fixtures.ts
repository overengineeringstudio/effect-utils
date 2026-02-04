/**
 * Shared fixtures for DumpOutput stories.
 *
 * @internal
 */

import type { DumpState } from './schema.ts'

// =============================================================================
// State Factories
// =============================================================================

export const createLoadingState = (): DumpState => ({
  _tag: 'Loading',
  databaseId: 'abc123',
})

export const createIntrospectingState = (): DumpState => ({
  _tag: 'Introspecting',
  databaseId: 'abc123',
})

export const createFetchingState = (pageCount: number): DumpState => ({
  _tag: 'Fetching',
  databaseId: 'abc123',
  dbName: 'Tasks',
  pageCount,
  outputPath: './dump/tasks.json',
})

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

export const createErrorState = (): DumpState => ({
  _tag: 'Error',
  message: 'Rate limited by Notion API',
})
