import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, Stream } from 'effect'

import { type View, ViewSchema } from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'

/** Views list response */
const ViewsResponseSchema = PaginatedResponse(ViewSchema)

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a view */
export interface RetrieveViewOptions {
  /** View ID to retrieve */
  readonly viewId: string
}

/** Options for listing views */
export interface ListViewsOptions extends PaginationOptions {
  /** Database ID to list views for */
  readonly databaseId: string
  /** Optionally filter to views for a specific data source */
  readonly dataSourceId?: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a view by ID.
 *
 * @see https://developers.notion.com/reference/retrieve-a-view
 */
export const retrieve = Effect.fn('NotionViews.retrieve')(function* (opts: RetrieveViewOptions) {
  return yield* get({
    path: `/views/${opts.viewId}`,
    responseSchema: ViewSchema,
  })
})

/** Internal helper to build query params */
const buildListParams = (opts: ListViewsOptions): string => {
  const params = new URLSearchParams()
  params.set('database_id', opts.databaseId)
  if (opts.dataSourceId !== undefined) params.set('data_source_id', opts.dataSourceId)
  if (opts.startCursor !== undefined) params.set('start_cursor', opts.startCursor)
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize))
  return params.toString()
}

/** Internal raw list */
const listRaw = Effect.fn('NotionViews.list')(function* (opts: ListViewsOptions) {
  const queryString = buildListParams(opts)
  const response = yield* get({
    path: `/views?${queryString}`,
    responseSchema: ViewsResponseSchema,
  })
  return toPaginatedResult(response)
})

/**
 * List views for a database.
 *
 * @see https://developers.notion.com/reference/list-views
 */
export const list = (
  opts: ListViewsOptions,
): Effect.Effect<PaginatedResult<View>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  listRaw(opts)

/**
 * List all views with automatic pagination.
 *
 * @see https://developers.notion.com/reference/list-views
 */
export const listStream = (
  opts: Omit<ListViewsOptions, 'startCursor'>,
): Stream.Stream<View, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const listOpts: ListViewsOptions =
          Option.isSome(cursor) === true ? { ...opts, startCursor: cursor.value } : { ...opts }
        return listRaw(listOpts).pipe(
          Effect.map((result) => {
            const chunk = Chunk.fromIterable(result.results)

            if (result.hasMore === false || Option.isNone(result.nextCursor) === true) {
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

/** Notion Views API */
export const NotionViews = {
  retrieve,
  list,
  listStream,
} as const
