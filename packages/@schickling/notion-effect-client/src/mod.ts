/**
 * Effect-native HTTP client for the Notion API.
 *
 * Uses `@effect/platform` HttpClient for all API calls.
 *
 * @see https://developers.notion.com/reference
 * @module
 */

import { Layer } from 'effect'
import { type NotionClientConfig, NotionConfig } from './config.ts'

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export type {
  AppendBlockChildrenOptions,
  DeleteBlockOptions,
  RetrieveBlockChildrenOptions,
  RetrieveBlockOptions,
  UpdateBlockOptions,
} from './blocks.ts'
export { NotionBlocks } from './blocks.ts'
// Config
export {
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  type NotionClientConfig,
  NotionConfig,
} from './config.ts'
export type {
  DatabaseFilter,
  DatabaseSort,
  QueryDatabaseOptions,
  RetrieveDatabaseOptions,
} from './databases.ts'
// Services
export { NotionDatabases } from './databases.ts'
// Error
export { NotionApiError, NotionErrorCode, NotionErrorResponse } from './error.ts'
// Pagination utilities
export type { PaginatedResult, PaginationOptions } from './internal/pagination.ts'
export type {
  ArchivePageOptions,
  CreatePageOptions,
  PageParent,
  RetrievePageOptions,
  UpdatePageOptions,
} from './pages.ts'
export { NotionPages } from './pages.ts'
export type { SearchFilter, SearchOptions, SearchSort } from './search.ts'

export { NotionSearch } from './search.ts'
export type { ListUsersOptions, RetrieveUserOptions } from './users.ts'
export { NotionUsers } from './users.ts'

// -----------------------------------------------------------------------------
// Layer
// -----------------------------------------------------------------------------

/**
 * Create a layer providing NotionConfig from configuration.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from 'effect'
 * import { HttpClient } from '@effect/platform'
 * import { NotionConfigLive, NotionDatabases } from '@schickling/notion-effect-client'
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* NotionDatabases.query({
 *     databaseId: 'abc-123',
 *   })
 *   return result
 * })
 *
 * const MainLayer = Layer.mergeAll(
 *   NotionConfigLive({ authToken: process.env.NOTION_TOKEN! }),
 *   HttpClient.layer,
 * )
 *
 * program.pipe(Effect.provide(MainLayer), Effect.runPromise)
 * ```
 */
export const NotionConfigLive = (config: NotionClientConfig): Layer.Layer<NotionConfig> =>
  Layer.succeed(NotionConfig, config)
