import type { HttpClient } from '@effect/platform'
import { type Page, PageSchema } from '@overeng/notion-effect-schema'
import { Effect, type Schema } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get, patch, post } from './internal/http.ts'
import { decodePage, type PageDecodeError, type TypedPage } from './typed-page.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parent types for creating pages */
export type PageParent =
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'page_id'; readonly page_id: string }

/** Base options for retrieving a page */
export interface RetrievePageOptionsBase {
  /** Page ID to retrieve */
  readonly pageId: string
}

/** Options for retrieving a page (without schema = raw Page result) */
export interface RetrievePageOptions extends RetrievePageOptionsBase {
  /** Schema to decode page properties (omit for raw Page result) */
  readonly schema?: undefined
}

/** Options for retrieving a page with schema-based decoding */
export interface RetrievePageWithSchemaOptions<TProperties, I, R> extends RetrievePageOptionsBase {
  /** Schema to decode page properties */
  readonly schema: Schema.Schema<TProperties, I, R>
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
 * Returns raw Page result, or TypedPage result when a schema is provided.
 *
 * @example
 * ```ts
 * // Without schema - returns raw Page object
 * const raw = yield* NotionPages.retrieve({ pageId: 'abc123' })
 *
 * // With schema - returns typed page with decoded properties
 * const TaskSchema = Schema.Struct({
 *   Name: Title.asString,
 *   Status: Select.asOption,
 * })
 * const typed = yield* NotionPages.retrieve({
 *   pageId: 'abc123',
 *   schema: TaskSchema,
 * })
 * // typed.properties.Name is string
 * ```
 *
 * @see https://developers.notion.com/reference/retrieve-a-page
 */
export function retrieve(
  opts: RetrievePageOptions,
): Effect.Effect<Page, NotionApiError, NotionConfig | HttpClient.HttpClient>
export function retrieve<TProperties, I, R>(
  opts: RetrievePageWithSchemaOptions<TProperties, I, R>,
): Effect.Effect<
  TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
>
export function retrieve<TProperties, I, R>(
  opts: RetrievePageOptions | RetrievePageWithSchemaOptions<TProperties, I, R>,
): Effect.Effect<
  Page | TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
> {
  return Effect.gen(function* () {
    const page = yield* get(`/pages/${opts.pageId}`, PageSchema)

    if (opts.schema !== undefined) {
      return yield* decodePage(page, opts.schema)
    }

    return page
  }).pipe(
    Effect.withSpan('NotionPages.retrieve', {
      attributes: { 'notion.page_id': opts.pageId },
    }),
  )
}

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
