import type { HttpClient } from '@effect/platform'
import { DatabaseSchema, type Page, PageSchema } from '@schickling/notion-effect-schema'
import { Effect, Option, type Stream } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get, post } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  paginatedStream,
  toPaginatedResult,
} from './internal/pagination.ts'

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

/** Options for querying a database */
export interface QueryDatabaseOptions extends PaginationOptions {
  /** Database ID to query */
  readonly databaseId: string
  /** Filter to apply */
  readonly filter?: DatabaseFilter
  /** Sorts to apply */
  readonly sorts?: readonly DatabaseSort[]
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

/**
 * Query a database with filters and pagination.
 *
 * Returns a single page of results with cursor for next page.
 *
 * @see https://developers.notion.com/reference/post-database-query
 */
export const query = (
  opts: QueryDatabaseOptions,
): Effect.Effect<PaginatedResult<Page>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body: Record<string, unknown> = {}

    if (opts.filter !== undefined) {
      body.filter = opts.filter
    }

    if (opts.sorts !== undefined) {
      body.sorts = opts.sorts
    }

    if (opts.startCursor !== undefined) {
      body.start_cursor = opts.startCursor
    }

    if (opts.pageSize !== undefined) {
      body.page_size = opts.pageSize
    }

    const response = yield* post(
      `/databases/${opts.databaseId}/query`,
      body,
      QueryDatabaseResponseSchema,
    )

    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionDatabases.query', {
      attributes: { 'notion.database_id': opts.databaseId },
    }),
  )

/**
 * Query a database with automatic pagination.
 *
 * Returns a stream that automatically fetches all pages.
 *
 * @see https://developers.notion.com/reference/post-database-query
 */
export const queryStream = (
  opts: Omit<QueryDatabaseOptions, 'startCursor'>,
): Stream.Stream<Page, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  paginatedStream((cursor) =>
    Effect.gen(function* () {
      const body: Record<string, unknown> = {}

      if (opts.filter !== undefined) {
        body.filter = opts.filter
      }

      if (opts.sorts !== undefined) {
        body.sorts = opts.sorts
      }

      if (Option.isSome(cursor)) {
        body.start_cursor = cursor.value
      }

      if (opts.pageSize !== undefined) {
        body.page_size = opts.pageSize
      }

      return yield* post(`/databases/${opts.databaseId}/query`, body, QueryDatabaseResponseSchema)
    }),
  )

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Databases API */
export const NotionDatabases = {
  retrieve,
  query,
  queryStream,
} as const
