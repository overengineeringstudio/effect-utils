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
  BlockTree,
  BlockTreeNode,
  BlockWithDepth,
  DeleteBlockOptions,
  RetrieveBlockChildrenOptions,
  RetrieveBlockOptions,
  RetrieveNestedOptions,
  UpdateBlockOptions,
} from './blocks.ts'
export { type BlockInsertPosition, NotionBlocks } from './blocks.ts'
// Comments
export type { CommentParentInput, CreateCommentOptions, ListCommentsOptions } from './comments.ts'
export { NotionComments } from './comments.ts'
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
  QueryDatabaseOptionsBase,
  QueryDatabaseWithSchemaOptions,
  RetrieveDatabaseOptions,
  TypedPaginatedResult,
} from './databases.ts'
// Custom emojis
export type { CustomEmoji } from './custom-emojis.ts'
export { NotionCustomEmojis } from './custom-emojis.ts'
// Data sources
export type {
  CreateDataSourceOptions,
  RetrieveDataSourceOptions,
  UpdateDataSourceOptions,
} from './data-sources.ts'
export { NotionDataSources } from './data-sources.ts'
// Services
export { NotionDatabases } from './databases.ts'
// Error
export { NotionApiError, NotionErrorCode, NotionErrorResponse } from './error.ts'
// File uploads
export type { UploadFileOptions } from './files.ts'
export { NotionFiles } from './files.ts'
// Pagination utilities
export type { PaginatedResult, PaginationOptions } from './internal/pagination.ts'
// Markdown converter
export type {
  AnyBlockTransformer,
  BlocksToMarkdownOptions,
  BlockTransformer,
  BlockTransformerEffect,
  BlockTransformers,
  BlockWithData,
  PageToMarkdownOptions,
} from './markdown.ts'
export {
  BlockHelpers,
  getBlockCaption,
  getBlockRichText,
  getBlockUrl,
  getCalloutIcon,
  getParagraphIcon,
  getChildDatabaseTitle,
  getChildPageTitle,
  getCodeLanguage,
  getEquationExpression,
  getTableRowCells,
  isTodoChecked,
  markdownToBlocks,
  NotionMarkdown,
  parseInlineMarkdown,
} from './markdown.ts'
export type {
  ArchivePageOptions,
  CreatePageOptions,
  GetMarkdownOptions,
  MarkdownContentUpdate,
  MovePageOptions,
  PageParent,
  RetrievePageOptions,
  RetrievePageOptionsBase,
  RetrievePageWithSchemaOptions,
  UpdateMarkdownOptions,
  UpdatePageOptions,
} from './pages.ts'
export { NotionPages } from './pages.ts'
// Schema helpers for database metadata
export type { RelationTarget, RollupConfig } from './schema-helpers.ts'
export { SchemaHelpers, SchemaMismatchError, SchemaMetaMissingError } from './schema-helpers.ts'
export type { SearchFilter, SearchOptions, SearchSort } from './search.ts'
export { NotionSearch } from './search.ts'
// Typed page utilities
export { PageDecodeError, type TypedPage } from './typed-page.ts'
export type { ListUsersOptions, RetrieveUserOptions } from './users.ts'
export { NotionUsers } from './users.ts'
// Views
export type {
  CreateViewOptions,
  DeleteViewOptions,
  ListViewsOptions,
  RetrieveViewOptions,
  UpdateViewOptions,
} from './views.ts'
export { NotionViews } from './views.ts'

// -----------------------------------------------------------------------------
// Layer
// -----------------------------------------------------------------------------

/**
 * Create a layer providing NotionConfig from configuration.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Redacted } from 'effect'
 * import { HttpClient } from '@effect/platform'
 * import { NotionConfigLive, NotionDatabases } from '@overeng/notion-effect-client'
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* NotionDatabases.query({
 *     databaseId: 'abc-123',
 *   })
 *   return result
 * })
 *
 * const MainLayer = Layer.mergeAll(
 *   NotionConfigLive({ authToken: Redacted.make(process.env.NOTION_TOKEN ?? '') }),
 *   HttpClient.layer,
 * )
 *
 * program.pipe(Effect.provide(MainLayer), Effect.runPromise)
 * ```
 */
export const NotionConfigLive = (config: NotionClientConfig): Layer.Layer<NotionConfig> =>
  Layer.succeed(NotionConfig, config)
