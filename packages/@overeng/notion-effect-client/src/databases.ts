import type { HttpClient } from '@effect/platform'
import { Effect, Option, type Schema, Stream } from 'effect'

import type { DataSourceSchema, Page } from '@overeng/notion-effect-schema'
import {
  DataSourceSchema as DataSourceSchemaCodec,
  DatabaseSchema,
  PageSchema,
} from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get, patch, post } from './internal/http.ts'
import {
  paginate,
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'
import { decodePage, decodePages, type PageDecodeError, type TypedPage } from './typed-page.ts'

/** Query database response */
const QueryDatabaseResponseSchema = PaginatedResponse(PageSchema)

// -----------------------------------------------------------------------------
// Query Types
// -----------------------------------------------------------------------------

/** Filter for database queries */
export interface DatabaseFilter {
  readonly [key: string]: unknown
}

/** Sort for database queries */
export interface DatabaseSort {
  readonly property?: string
  readonly timestamp?: 'created_time' | 'last_edited_time'
  readonly direction: 'ascending' | 'descending'
}

/** Base options for querying a data source */
export interface QueryDatabaseOptionsBase extends PaginationOptions {
  /** Data source ID to query (in API 2026-03-11, queries target data sources, not databases) */
  readonly dataSourceId: string
  /** Filter to apply */
  readonly filter?: DatabaseFilter
  /** Sorts to apply */
  readonly sorts?: readonly DatabaseSort[]
  /** Limit which properties are returned (property IDs) */
  readonly filterProperties?: readonly string[]
  /** Include trashed items in results */
  readonly inTrash?: boolean
}

/** Options for querying a database (without schema = raw Page results) */
export interface QueryDatabaseOptions extends QueryDatabaseOptionsBase {
  /** Schema to decode page properties (omit for raw Page results) */
  readonly schema?: undefined
}

/** Options for querying a database with schema-based decoding */
export interface QueryDatabaseWithSchemaOptions<
  TProperties,
  I,
  R,
> extends QueryDatabaseOptionsBase {
  /** Schema to decode page properties */
  readonly schema: Schema.Schema<TProperties, I, R>
}

/** Options for retrieving a database */
export interface RetrieveDatabaseOptions {
  /** Database ID to retrieve */
  readonly databaseId: string
}

/** Options for creating a database */
export interface CreateDatabaseOptions {
  /** Parent page/block/workspace for the database */
  readonly parent:
    | { readonly type: 'page_id'; readonly page_id: string }
    | { readonly type: 'block_id'; readonly block_id: string }
    | { readonly type: 'workspace'; readonly workspace: true }
  /** Database title rich text */
  readonly title: readonly unknown[]
  /**
   * Property schema definitions. In API 2026-03-11 these live on the database's
   * initial data source, not on the database object; `create` nests them under
   * `initial_data_source` for you (see {@link create}).
   */
  readonly properties: Record<string, unknown>
  /** Optional title for the initial data source (defaults to the database title) */
  readonly initialDataSourceTitle?: readonly unknown[]
  /** Database description rich text */
  readonly description?: readonly unknown[]
  /** Whether the database should be displayed inline */
  readonly is_inline?: boolean
  /** Database icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
  /** Database cover image */
  readonly cover?: {
    readonly type: 'external'
    readonly external: { readonly url: string }
  }
}

/** Options for updating a database */
export interface UpdateDatabaseOptions {
  /** Database ID to update */
  readonly databaseId: string
  /** Database title rich text */
  readonly title?: readonly unknown[]
  /** Property schema definitions */
  readonly properties?: Record<string, unknown>
  /** Database description rich text */
  readonly description?: readonly unknown[]
  /** Whether the database is in trash */
  readonly in_trash?: boolean
  /** Database icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
    | null
  /** Database cover image */
  readonly cover?: {
    readonly type: 'external'
    readonly external: { readonly url: string }
  } | null
}

/** Options for archiving a database */
export interface ArchiveDatabaseOptions {
  /** Database ID to archive */
  readonly databaseId: string
}

/** Options for resolving a database query target */
export interface ResolveQueryTargetOptions {
  /** Database ID to resolve */
  readonly databaseId: string
}

/** Resolved target info for querying and schema validation */
export interface DatabaseQueryTarget {
  /** Retrieved database metadata */
  readonly database: DatabaseSchema
  /** Property schema source for validation/introspection */
  readonly schemaSource: DatabaseSchema | DataSourceSchema
  /** Data source ID used by query endpoints */
  readonly dataSourceId: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a database by ID.
 *
 * @see https://developers.notion.com/reference/retrieve-a-database
 */
export const retrieve = Effect.fn('NotionDatabases.retrieve')(function* (
  opts: RetrieveDatabaseOptions,
) {
  return yield* get({
    path: `/databases/${opts.databaseId}`,
    responseSchema: DatabaseSchema,
  })
})

/**
 * Create a database.
 *
 * In API 2026-03-11 the property schema lives on the database's **initial data
 * source**, not on the database object: a top-level `properties` key is silently
 * dropped, yielding an empty `Name`-only database. This nests `opts.properties`
 * under `initial_data_source` so callers keep passing a flat property map.
 *
 * @see https://developers.notion.com/reference/create-a-database
 */
export const create = Effect.fn('NotionDatabases.create')(function* (opts: CreateDatabaseOptions) {
  const initialDataSource: Record<string, unknown> = { properties: opts.properties }
  if (opts.initialDataSourceTitle !== undefined) {
    initialDataSource.title = opts.initialDataSourceTitle
  }

  const body: Record<string, unknown> = {
    parent: opts.parent,
    title: opts.title,
    initial_data_source: initialDataSource,
  }

  if (opts.description !== undefined) body.description = opts.description
  if (opts.is_inline !== undefined) body.is_inline = opts.is_inline
  if (opts.icon !== undefined) body.icon = opts.icon
  if (opts.cover !== undefined) body.cover = opts.cover

  return yield* post({
    path: '/databases',
    body,
    responseSchema: DatabaseSchema,
  })
})

/**
 * Update a database.
 *
 * @see https://developers.notion.com/reference/update-a-database
 */
export const update = Effect.fn('NotionDatabases.update')(function* (opts: UpdateDatabaseOptions) {
  const { databaseId, ...body } = opts

  return yield* patch({
    path: `/databases/${databaseId}`,
    body,
    responseSchema: DatabaseSchema,
  })
})

/**
 * Archive a database by moving it to trash.
 *
 * @see https://developers.notion.com/reference/update-a-database
 */
export const archive = (opts: ArchiveDatabaseOptions) =>
  update({ databaseId: opts.databaseId, in_trash: true })

/**
 * Resolve the query target for a database.
 *
 * In API 2026-03-11, queries and property schemas live on the first child data
 * source rather than on the database itself.
 */
export const resolveQueryTarget = Effect.fn('NotionDatabases.resolveQueryTarget')(function* (
  opts: ResolveQueryTargetOptions,
) {
  const database = yield* retrieve({ databaseId: opts.databaseId })
  const firstDataSourceId = database.data_sources?.[0]?.id
  const dataSourceId = firstDataSourceId ?? database.id

  if (firstDataSourceId === undefined) {
    return {
      database,
      schemaSource: database,
      dataSourceId,
    } satisfies DatabaseQueryTarget
  }

  const schemaSource = yield* get({
    path: `/data_sources/${dataSourceId}`,
    responseSchema: DataSourceSchemaCodec,
  })

  return {
    database,
    schemaSource,
    dataSourceId,
  } satisfies DatabaseQueryTarget
})

/** Result of a typed database query */
export interface TypedPaginatedResult<TProperties> {
  /** Decoded typed pages */
  readonly results: readonly TypedPage<TProperties>[]
  /** Cursor for next page, if more results exist */
  readonly nextCursor: Option.Option<string>
  /** Whether more results are available */
  readonly hasMore: boolean
}

/** Internal helper to build query body */
const buildQueryBody = (opts: QueryDatabaseOptionsBase): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  if (opts.filter !== undefined) body.filter = opts.filter
  if (opts.sorts !== undefined) body.sorts = opts.sorts
  if (opts.pageSize !== undefined) body.page_size = opts.pageSize
  if (opts.startCursor !== undefined) body.start_cursor = opts.startCursor
  if (opts.inTrash !== undefined) body.in_trash = opts.inTrash
  return body
}

/** Build query string params for filter_properties (must be query params, not body) */
const buildQueryParams = (opts: QueryDatabaseOptionsBase): string => {
  if (opts.filterProperties === undefined || opts.filterProperties.length === 0) return ''
  const params = new URLSearchParams()
  for (const prop of opts.filterProperties) {
    params.append('filter_properties', prop)
  }
  return `?${params.toString()}`
}

/** Internal raw query - always returns raw pages, used by both query and queryStream */
const queryRaw = (
  opts: QueryDatabaseOptionsBase,
): Effect.Effect<PaginatedResult<Page>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = buildQueryBody(opts)
    const queryParams = buildQueryParams(opts)
    const response = yield* post({
      path: `/data_sources/${opts.dataSourceId}/query${queryParams}`,
      body,
      responseSchema: QueryDatabaseResponseSchema,
    })
    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionDatabases.query', {
      attributes: { 'notion.data_source_id': opts.dataSourceId },
    }),
  )

/**
 * Query a database with filters and pagination.
 *
 * Returns raw Page results, or TypedPage results when a schema is provided.
 *
 * @example
 * ```ts
 * // Without schema - returns raw Page objects
 * const raw = yield* NotionDatabases.query({ dataSourceId: 'abc123' })
 *
 * // With schema - returns typed pages with decoded properties
 * const TaskSchema = Schema.Struct({
 *   Name: NotionSchema.title,
 *   Status: NotionSchema.select(),
 * })
 * const typed = yield* NotionDatabases.query({
 *   dataSourceId: 'abc123',
 *   schema: TaskSchema,
 * })
 * // typed.results[0].properties.Name is string
 * ```
 *
 * @see https://developers.notion.com/reference/post-data-source-query
 */
export function query(
  opts: QueryDatabaseOptions,
): Effect.Effect<PaginatedResult<Page>, NotionApiError, NotionConfig | HttpClient.HttpClient>
export function query<TProperties, I, R>(
  opts: QueryDatabaseWithSchemaOptions<TProperties, I, R>,
): Effect.Effect<
  TypedPaginatedResult<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
>
// oxlint-disable-next-line overeng/jsdoc-require-exports -- JSDoc is on first overload signature
export function query<TProperties, I, R>(
  opts: QueryDatabaseOptions | QueryDatabaseWithSchemaOptions<TProperties, I, R>,
): Effect.Effect<
  PaginatedResult<Page> | TypedPaginatedResult<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
> {
  return Effect.gen(function* () {
    const result = yield* queryRaw(opts)

    if (opts.schema !== undefined) {
      const typedResults = yield* decodePages({
        pages: result.results,
        schema: opts.schema,
      })
      return {
        results: typedResults,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      } as TypedPaginatedResult<TProperties>
    }

    return result
  })
}

/**
 * Query a database with automatic pagination.
 *
 * Returns a stream of raw Page objects, or TypedPage objects when a schema is provided.
 *
 * @example
 * ```ts
 * // Without schema - streams raw Page objects
 * const pages = yield* NotionDatabases.queryStream({ dataSourceId: 'abc123' })
 *   .pipe(Stream.runCollect)
 *
 * // With schema - streams typed pages with decoded properties
 * const TaskSchema = Schema.Struct({
 *   Name: NotionSchema.title,
 *   Status: NotionSchema.select(),
 * })
 * const tasks = yield* NotionDatabases.queryStream({
 *   dataSourceId: 'abc123',
 *   schema: TaskSchema,
 * }).pipe(Stream.runCollect)
 * ```
 *
 * @see https://developers.notion.com/reference/post-data-source-query
 */
export function queryStream(
  opts: Omit<QueryDatabaseOptions, 'startCursor'>,
): Stream.Stream<Page, NotionApiError, NotionConfig | HttpClient.HttpClient>
export function queryStream<TProperties, I, R>(
  opts: Omit<QueryDatabaseWithSchemaOptions<TProperties, I, R>, 'startCursor'>,
): Stream.Stream<
  TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
>
// oxlint-disable-next-line overeng/jsdoc-require-exports -- JSDoc is on first overload signature
export function queryStream<TProperties, I, R>(
  opts:
    | Omit<QueryDatabaseOptions, 'startCursor'>
    | Omit<QueryDatabaseWithSchemaOptions<TProperties, I, R>, 'startCursor'>,
): Stream.Stream<
  Page | TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
> {
  const baseStream: Stream.Stream<Page, NotionApiError, NotionConfig | HttpClient.HttpClient> =
    paginate(
      (cursor) =>
        queryRaw(
          Option.isSome(cursor) === true ? { ...opts, startCursor: cursor.value } : { ...opts },
        ),
      { emit: { _tag: 'items' } },
    )

  if (opts.schema !== undefined) {
    const schema = opts.schema
    return baseStream.pipe(Stream.mapEffect((page) => decodePage({ page, schema })))
  }

  return baseStream
}

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Databases API */
export const NotionDatabases = {
  retrieve,
  create,
  update,
  archive,
  resolveQueryTarget,
  query,
  queryStream,
} as const
