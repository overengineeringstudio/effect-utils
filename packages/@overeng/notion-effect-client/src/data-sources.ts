import { Effect } from 'effect'

import { DataSourceSchema } from '@overeng/notion-effect-schema'

import { get } from './internal/http.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a data source */
export interface RetrieveDataSourceOptions {
  /** Data source ID to retrieve */
  readonly dataSourceId: string
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

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Data Sources API */
export const NotionDataSources = {
  retrieve,
} as const
