import { Effect } from 'effect'

import { DataSourceSchema } from '@overeng/notion-effect-schema'

import { get, patch, post } from './internal/http.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a data source */
export interface RetrieveDataSourceOptions {
  /** Data source ID to retrieve */
  readonly dataSourceId: string
}

/** Options for creating a data source within a database */
export interface CreateDataSourceOptions {
  /** Parent database */
  readonly parent: { readonly type: 'database_id'; readonly database_id: string }
  /** Property schema definitions */
  readonly properties: Record<string, unknown>
  /** Data source title */
  readonly title?: readonly unknown[]
  /** Data source icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
}

/** Options for updating a data source */
export interface UpdateDataSourceOptions {
  /** Data source ID to update */
  readonly dataSourceId: string
  /** Update title */
  readonly title?: readonly unknown[]
  /** Update icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
    | null
  /** Update property schemas */
  readonly properties?: Record<string, unknown>
  /** Move to trash */
  readonly in_trash?: boolean
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a data source by ID.
 *
 * In API 2026-03-11, properties/schema definitions live on data sources
 * rather than on the database object.
 *
 * @see https://developers.notion.com/reference/retrieve-a-data-source
 */
export const retrieve = Effect.fn('NotionDataSources.retrieve')(function* (
  opts: RetrieveDataSourceOptions,
) {
  return yield* get({
    path: `/data_sources/${opts.dataSourceId}`,
    responseSchema: DataSourceSchema,
  })
})

/**
 * Create a data source within a database.
 *
 * @see https://developers.notion.com/reference/create-a-data-source
 */
export const create = Effect.fn('NotionDataSources.create')(function* (
  opts: CreateDataSourceOptions,
) {
  const body: Record<string, unknown> = {
    parent: opts.parent,
    properties: opts.properties,
  }

  if (opts.title !== undefined) body.title = opts.title
  if (opts.icon !== undefined) body.icon = opts.icon

  return yield* post({
    path: '/data_sources',
    body,
    responseSchema: DataSourceSchema,
  })
})

/**
 * Update a data source.
 *
 * @see https://developers.notion.com/reference/update-a-data-source
 */
export const update = Effect.fn('NotionDataSources.update')(function* (
  opts: UpdateDataSourceOptions,
) {
  const { dataSourceId, ...body } = opts

  return yield* patch({
    path: `/data_sources/${dataSourceId}`,
    body,
    responseSchema: DataSourceSchema,
  })
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Data Sources API */
export const NotionDataSources = {
  retrieve,
  create,
  update,
} as const
