import type { HttpClient } from '@effect/platform'
import { Effect, Option, Schema, type Stream } from 'effect'

import { type View, type ViewType, ViewSchema } from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { del, get, patch, post } from './internal/http.ts'
import {
  paginate,
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
  paginate(
    (cursor) =>
      listRaw(
        Option.isSome(cursor) === true ? { ...opts, startCursor: cursor.value } : { ...opts },
      ),
    { emit: { _tag: 'items' } },
  )

// -----------------------------------------------------------------------------
// Write Operations
// -----------------------------------------------------------------------------

/** Options for creating a view */
export interface CreateViewOptions {
  /** Database ID */
  readonly databaseId: string
  /** Data source ID */
  readonly dataSourceId: string
  /** View name */
  readonly name: string
  /** View type */
  readonly type: ViewType
  /** View-specific configuration (passed through) */
  readonly configuration?: unknown
  /** Filter configuration */
  readonly filter?: unknown
  /** Sort configuration */
  readonly sorts?: unknown
}

/** Options for updating a view */
export interface UpdateViewOptions {
  /** View ID to update */
  readonly viewId: string
  /** Update name */
  readonly name?: string
  /** Update configuration */
  readonly configuration?: unknown
  /** Update filter */
  readonly filter?: unknown
  /** Update sorts */
  readonly sorts?: unknown
}

/** Options for deleting a view */
export interface DeleteViewOptions {
  /** View ID to delete */
  readonly viewId: string
}

/** Delete response schema (minimal) */
const DeleteViewResponseSchema = Schema.Struct({
  object: Schema.Literal('view'),
  id: Schema.String,
})

/**
 * Create a new view for a database.
 *
 * @see https://developers.notion.com/reference/create-a-view
 */
export const create = Effect.fn('NotionViews.create')(function* (opts: CreateViewOptions) {
  const body: Record<string, unknown> = {
    database_id: opts.databaseId,
    data_source_id: opts.dataSourceId,
    name: opts.name,
    type: opts.type,
  }

  if (opts.configuration !== undefined) body.configuration = opts.configuration
  if (opts.filter !== undefined) body.filter = opts.filter
  if (opts.sorts !== undefined) body.sorts = opts.sorts

  return yield* post({
    path: '/views',
    body,
    responseSchema: ViewSchema,
  })
})

/**
 * Update a view.
 *
 * @see https://developers.notion.com/reference/update-a-view
 */
export const update = Effect.fn('NotionViews.update')(function* (opts: UpdateViewOptions) {
  const { viewId, ...body } = opts

  return yield* patch({
    path: `/views/${viewId}`,
    body,
    responseSchema: ViewSchema,
  })
})

/**
 * Delete a view.
 *
 * @see https://developers.notion.com/reference/delete-a-view
 */
export const deleteView = Effect.fn('NotionViews.delete')(function* (opts: DeleteViewOptions) {
  return yield* del({
    path: `/views/${opts.viewId}`,
    responseSchema: DeleteViewResponseSchema,
  })
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Views API */
export const NotionViews = {
  retrieve,
  list,
  listStream,
  create,
  update,
  delete: deleteView,
} as const
