import { PageSchema } from '@schickling/notion-effect-schema'
import { Effect } from 'effect'
import { get, patch, post } from './internal/http.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parent types for creating pages */
export type PageParent =
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'page_id'; readonly page_id: string }

/** Options for retrieving a page */
export interface RetrievePageOptions {
  /** Page ID to retrieve */
  readonly pageId: string
}

/** Options for creating a page */
export interface CreatePageOptions {
  /** Parent database or page */
  readonly parent: PageParent
  /** Page properties (key is property name or id) */
  readonly properties: Record<string, unknown>
  /** Page content as array of block objects */
  readonly children?: readonly unknown[]
  /** Page icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
  /** Page cover image */
  readonly cover?: { readonly type: 'external'; readonly external: { readonly url: string } }
}

/** Options for updating a page */
export interface UpdatePageOptions {
  /** Page ID to update */
  readonly pageId: string
  /** Properties to update (key is property name or id) */
  readonly properties?: Record<string, unknown>
  /** Whether to archive the page */
  readonly archived?: boolean
  /** Page icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | null
  /** Page cover image */
  readonly cover?: { readonly type: 'external'; readonly external: { readonly url: string } } | null
}

/** Options for archiving a page */
export interface ArchivePageOptions {
  /** Page ID to archive */
  readonly pageId: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a page by ID.
 *
 * @see https://developers.notion.com/reference/retrieve-a-page
 */
export const retrieve = Effect.fn('NotionPages.retrieve')(function* (opts: RetrievePageOptions) {
  return yield* get(`/pages/${opts.pageId}`, PageSchema)
})

/**
 * Create a new page.
 *
 * @see https://developers.notion.com/reference/post-page
 */
export const create = Effect.fn('NotionPages.create')(function* (opts: CreatePageOptions) {
  const body: Record<string, unknown> = {
    parent: opts.parent,
    properties: opts.properties,
  }

  if (opts.children !== undefined) {
    body.children = opts.children
  }

  if (opts.icon !== undefined) {
    body.icon = opts.icon
  }

  if (opts.cover !== undefined) {
    body.cover = opts.cover
  }

  return yield* post('/pages', body, PageSchema)
})

/**
 * Update a page's properties.
 *
 * @see https://developers.notion.com/reference/patch-page
 */
export const update = Effect.fn('NotionPages.update')(function* (opts: UpdatePageOptions) {
  const body: Record<string, unknown> = {}

  if (opts.properties !== undefined) {
    body.properties = opts.properties
  }

  if (opts.archived !== undefined) {
    body.archived = opts.archived
  }

  if (opts.icon !== undefined) {
    body.icon = opts.icon
  }

  if (opts.cover !== undefined) {
    body.cover = opts.cover
  }

  return yield* patch(`/pages/${opts.pageId}`, body, PageSchema)
})

/**
 * Archive (soft-delete) a page.
 *
 * @see https://developers.notion.com/reference/patch-page
 */
export const archive = Effect.fn('NotionPages.archive')(function* (opts: ArchivePageOptions) {
  return yield* patch(`/pages/${opts.pageId}`, { archived: true }, PageSchema)
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Pages API */
export const NotionPages = {
  retrieve,
  create,
  update,
  archive,
} as const
