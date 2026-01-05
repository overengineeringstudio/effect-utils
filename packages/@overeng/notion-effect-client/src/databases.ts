import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, type Schema, Stream } from 'effect'

import type { Page } from '@overeng/notion-effect-schema'
import { DatabaseSchema, PageSchema } from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get, post } from './internal/http.ts'
import {
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

/** Base options for querying a database */
export interface QueryDatabaseOptionsBase extends PaginationOptions {
  /** Database ID to query */
  readonly databaseId: string
  /** Filter to apply */
  readonly filter?: DatabaseFilter
  /** Sorts to apply */
  readonly sorts?: readonly DatabaseSort[]
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
  return yield* get(`/databases/${opts.databaseId}`, DatabaseSchema)
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
  return body
}

/** Internal raw query - always returns raw pages, used by both query and queryStream */
const queryRaw = (
  opts: QueryDatabaseOptionsBase,
): Effect.Effect<PaginatedResult<Page>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = buildQueryBody(opts)
    const response = yield* post({
      path: `/databases/${opts.databaseId}/query`,
      body,
      responseSchema: QueryDatabaseResponseSchema,
    })
    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionDatabases.query', {
      attributes: { 'notion.database_id': opts.databaseId },
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
 * const raw = yield* NotionDatabases.query({ databaseId: 'abc123' })
 *
 * // With schema - returns typed pages with decoded properties
 * const TaskSchema = Schema.Struct({
 *   Name: Title.asString,
 *   Status: Select.asOption,
 * })
 * const typed = yield* NotionDatabases.query({
 *   databaseId: 'abc123',
 *   schema: TaskSchema,
 * })
 * // typed.results[0].properties.Name is string
 * ```
 *
 * @see https://developers.notion.com/reference/post-database-query
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
      const typedResults = yield* decodePages(result.results, opts.schema)
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
 * const pages = yield* NotionDatabases.queryStream({ databaseId: 'abc123' })
 *   .pipe(Stream.runCollect)
 *
 * // With schema - streams typed pages with decoded properties
 * const TaskSchema = Schema.Struct({
 *   Name: Title.asString,
 *   Status: Select.asOption,
 * })
 * const tasks = yield* NotionDatabases.queryStream({
 *   databaseId: 'abc123',
 *   schema: TaskSchema,
 * }).pipe(Stream.runCollect)
 * ```
 *
 * @see https://developers.notion.com/reference/post-database-query
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
export function queryStream<TProperties, I, R>(
  opts:
    | Omit<QueryDatabaseOptions, 'startCursor'>
    | Omit<QueryDatabaseWithSchemaOptions<TProperties, I, R>, 'startCursor'>,
): Stream.Stream<
  Page | TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
> {
  // Use queryRaw with Stream.unfoldChunkEffect for pagination
  const baseStream: Stream.Stream<Page, NotionApiError, NotionConfig | HttpClient.HttpClient> =
    Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
      Option.match(maybeNextCursor, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (cursor) => {
          const queryOpts: QueryDatabaseOptionsBase = Option.isSome(cursor)
            ? { ...opts, startCursor: cursor.value }
            : { ...opts }
          return queryRaw(queryOpts).pipe(
            Effect.map((result) => {
              const chunk = Chunk.fromIterable(result.results)

              if (!result.hasMore || Option.isNone(result.nextCursor)) {
                return Option.some([chunk, Option.none()] as const)
              }

              return Option.some([
                chunk,
                Option.some(Option.some(result.nextCursor.value)),
              ] as const)
            }),
          )
        },
      }),
    )

  if (opts.schema !== undefined) {
    const schema = opts.schema
    return baseStream.pipe(Stream.mapEffect((page) => decodePage(page, schema)))
  }

  return baseStream
}

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Databases API */
export const NotionDatabases = {
  retrieve,
  query,
  queryStream,
} as const
