import type { HttpClient } from '@effect/platform'
import { Effect, type Schema } from 'effect'

import {
  type Page,
  type PageMarkdown,
  PageMarkdownSchema,
  PageSchema,
} from '@overeng/notion-effect-schema'

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
  | { readonly type: 'data_source_id'; readonly data_source_id: string }
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
  /** Page content as array of block objects (mutually exclusive with markdown) */
  readonly children?: readonly unknown[]
  /** Markdown content for the page (mutually exclusive with children) */
  readonly markdown?: string
  /** Page icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
  /** Page cover image */
  readonly cover?: {
    readonly type: 'external'
    readonly external: { readonly url: string }
  }
}

/** Options for updating a page */
export interface UpdatePageOptions {
  /** Page ID to update */
  readonly pageId: string
  /** Properties to update (key is property name or id) */
  readonly properties?: Record<string, unknown>
  /** Whether the page is in trash */
  readonly in_trash?: boolean
  /** Whether the page is locked for editing */
  readonly is_locked?: boolean
  /** Clear all page content (used with templates) */
  readonly erase_content?: boolean
  /** Page icon */
  readonly icon?:
    | { readonly type: 'emoji'; readonly emoji: string }
    | { readonly type: 'external'; readonly external: { readonly url: string } }
    | { readonly type: 'icon'; readonly icon: { readonly name: string; readonly color?: string } }
    | null
  /** Page cover image */
  readonly cover?: {
    readonly type: 'external'
    readonly external: { readonly url: string }
  } | null
}

/** Options for archiving a page */
export interface ArchivePageOptions {
  /** Page ID to archive */
  readonly pageId: string
}

/** Options for getting page markdown */
export interface GetMarkdownOptions {
  /** Page ID */
  readonly pageId: string
}

/** Search-and-replace update for markdown content */
export interface MarkdownContentUpdate {
  readonly old_str: string
  readonly new_str: string
  readonly replace_all_matches?: boolean
}

/** Options for updating page markdown */
export type UpdateMarkdownOptions = {
  readonly pageId: string
} & (
  | {
      readonly type: 'update_content'
      readonly content_updates: readonly MarkdownContentUpdate[]
      readonly allow_deleting_content?: boolean
    }
  | {
      readonly type: 'replace_content'
      readonly new_str: string
      readonly allow_deleting_content?: boolean
    }
)

/** Options for moving a page */
export interface MovePageOptions {
  /** Page ID to move */
  readonly pageId: string
  /** New parent */
  readonly parent: PageParent
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
 *   Name: NotionSchema.title,
 *   Status: NotionSchema.select(),
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
// oxlint-disable-next-line overeng/jsdoc-require-exports -- JSDoc is on first overload signature
export function retrieve<TProperties, I, R>(
  opts: RetrievePageOptions | RetrievePageWithSchemaOptions<TProperties, I, R>,
): Effect.Effect<
  Page | TypedPage<TProperties>,
  NotionApiError | PageDecodeError,
  NotionConfig | HttpClient.HttpClient | R
> {
  return Effect.gen(function* () {
    const page = yield* get({
      path: `/pages/${opts.pageId}`,
      responseSchema: PageSchema,
    })

    if (opts.schema !== undefined) {
      return yield* decodePage({ page, schema: opts.schema })
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

  if (opts.markdown !== undefined) {
    body.markdown = opts.markdown
  }

  if (opts.icon !== undefined) {
    body.icon = opts.icon
  }

  if (opts.cover !== undefined) {
    body.cover = opts.cover
  }

  return yield* post({ path: '/pages', body, responseSchema: PageSchema })
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

  if (opts.in_trash !== undefined) {
    body.in_trash = opts.in_trash
  }

  if (opts.is_locked !== undefined) {
    body.is_locked = opts.is_locked
  }

  if (opts.erase_content !== undefined) {
    body.erase_content = opts.erase_content
  }

  if (opts.icon !== undefined) {
    body.icon = opts.icon
  }

  if (opts.cover !== undefined) {
    body.cover = opts.cover
  }

  return yield* patch({
    path: `/pages/${opts.pageId}`,
    body,
    responseSchema: PageSchema,
  })
})

/**
 * Archive (soft-delete) a page.
 *
 * @see https://developers.notion.com/reference/patch-page
 */
export const archive = Effect.fn('NotionPages.archive')(function* (opts: ArchivePageOptions) {
  return yield* patch({
    path: `/pages/${opts.pageId}`,
    body: { in_trash: true },
    responseSchema: PageSchema,
  })
})

/**
 * Get server-side markdown representation of a page.
 *
 * @see https://developers.notion.com/reference/get-page-markdown
 */
export const getMarkdown = Effect.fn('NotionPages.getMarkdown')(function* (
  opts: GetMarkdownOptions,
) {
  return yield* get({
    path: `/pages/${opts.pageId}/markdown`,
    responseSchema: PageMarkdownSchema,
  })
})

/**
 * Update page content via markdown (search-and-replace or full replace).
 *
 * @see https://developers.notion.com/reference/patch-page-markdown
 */
export const updateMarkdown = Effect.fn('NotionPages.updateMarkdown')(function* (
  opts: UpdateMarkdownOptions,
) {
  const { pageId, type, ...rest } = opts
  const body = { type, [type]: rest }

  return yield* patch({
    path: `/pages/${pageId}/markdown`,
    body,
    responseSchema: PageMarkdownSchema,
  })
})

/**
 * Move a page to a new parent.
 *
 * @see https://developers.notion.com/reference/post-page-move
 */
export const move = Effect.fn('NotionPages.move')(function* (opts: MovePageOptions) {
  return yield* post({
    path: `/pages/${opts.pageId}/move`,
    body: { parent: opts.parent },
    responseSchema: PageSchema,
  })
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
  getMarkdown,
  updateMarkdown,
  move,
} as const
