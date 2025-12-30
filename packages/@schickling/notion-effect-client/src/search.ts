import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { post } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'

// -----------------------------------------------------------------------------
// Temporary schemas until Phase 3 (Core Object Schemas) is complete
// -----------------------------------------------------------------------------

/** Search result can be a page or database - allows any additional properties */
const SearchResultSchema = Schema.Struct({
  object: Schema.Union(Schema.Literal('page'), Schema.Literal('database')),
  id: Schema.String,
}).annotations({ identifier: 'SearchResult' })

type SearchResult = typeof SearchResultSchema.Type

/** Search response */
const SearchResponseSchema = PaginatedResponse(SearchResultSchema)

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Filter for search (page or database only) */
export interface SearchFilter {
  readonly property: 'object'
  readonly value: 'page' | 'database'
}

/** Sort for search */
export interface SearchSort {
  readonly direction: 'ascending' | 'descending'
  readonly timestamp: 'last_edited_time'
}

/** Options for searching */
export interface SearchOptions extends PaginationOptions {
  /** Text to search for in page/database titles */
  readonly query?: string
  /** Filter to pages or databases only */
  readonly filter?: SearchFilter
  /** Sort order */
  readonly sort?: SearchSort
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/** Internal helper to build search body */
const buildSearchBody = (opts: SearchOptions): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  if (opts.query !== undefined) body.query = opts.query
  if (opts.filter !== undefined) body.filter = opts.filter
  if (opts.sort !== undefined) body.sort = opts.sort
  if (opts.startCursor !== undefined) body.start_cursor = opts.startCursor
  if (opts.pageSize !== undefined) body.page_size = opts.pageSize
  return body
}

/** Internal raw search - used by both search and searchStream */
const searchRaw = (
  opts: SearchOptions,
): Effect.Effect<
  PaginatedResult<SearchResult>,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const body = buildSearchBody(opts)
    const response = yield* post('/search', body, SearchResponseSchema)
    return toPaginatedResult(response)
  }).pipe(Effect.withSpan('NotionSearch.search'))

/**
 * Search pages and databases.
 *
 * Returns a single page of results with cursor for next page.
 *
 * @see https://developers.notion.com/reference/post-search
 */
export const search = (
  opts: SearchOptions = {},
): Effect.Effect<
  PaginatedResult<SearchResult>,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient
> => searchRaw(opts)

/**
 * Search pages and databases with automatic pagination.
 *
 * Returns a stream that automatically fetches all pages.
 *
 * @see https://developers.notion.com/reference/post-search
 */
export const searchStream = (
  opts: Omit<SearchOptions, 'startCursor'> = {},
): Stream.Stream<SearchResult, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const searchOpts: SearchOptions = Option.isSome(cursor)
          ? { ...opts, startCursor: cursor.value }
          : { ...opts }
        return searchRaw(searchOpts).pipe(
          Effect.map((result) => {
            const chunk = Chunk.fromIterable(result.results)

            if (!result.hasMore || Option.isNone(result.nextCursor)) {
              return Option.some([chunk, Option.none()] as const)
            }

            return Option.some([chunk, Option.some(Option.some(result.nextCursor.value))] as const)
          }),
        )
      },
    }),
  )

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Search API */
export const NotionSearch = {
  search,
  searchStream,
} as const
