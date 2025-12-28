import type { HttpClient } from '@effect/platform'
import { type Block, BlockSchema } from '@schickling/notion-effect-schema'
import { Effect, Option, Schema, type Stream } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { del, get, patch } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  paginatedStream,
  toPaginatedResult,
} from './internal/pagination.ts'

/** Block children response */
const BlockChildrenResponseSchema = PaginatedResponse(BlockSchema)

/** Append block children response */
const AppendBlockChildrenResponseSchema = Schema.Struct({
  object: Schema.Literal('list'),
  results: Schema.Array(BlockSchema),
})

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a block */
export interface RetrieveBlockOptions {
  /** Block ID to retrieve */
  readonly blockId: string
}

/** Options for retrieving block children */
export interface RetrieveBlockChildrenOptions extends PaginationOptions {
  /** Block ID to retrieve children for */
  readonly blockId: string
}

/** Options for appending block children */
export interface AppendBlockChildrenOptions {
  /** Block ID to append children to */
  readonly blockId: string
  /** Block objects to append */
  readonly children: readonly unknown[]
  /** Append after this block ID (optional) */
  readonly after?: string
}

/** Options for updating a block */
export interface UpdateBlockOptions {
  /** Block ID to update */
  readonly blockId: string
  /** Block type-specific content to update */
  readonly [key: string]: unknown
}

/** Options for deleting a block */
export interface DeleteBlockOptions {
  /** Block ID to delete */
  readonly blockId: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a block by ID.
 *
 * @see https://developers.notion.com/reference/retrieve-a-block
 */
export const retrieve = Effect.fn('NotionBlocks.retrieve')(function* (opts: RetrieveBlockOptions) {
  return yield* get(`/blocks/${opts.blockId}`, BlockSchema)
})

/**
 * Retrieve block children with pagination.
 *
 * Returns a single page of results with cursor for next page.
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveChildren = (
  opts: RetrieveBlockChildrenOptions,
): Effect.Effect<PaginatedResult<Block>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const params = new URLSearchParams()

    if (opts.startCursor !== undefined) {
      params.set('start_cursor', opts.startCursor)
    }

    if (opts.pageSize !== undefined) {
      params.set('page_size', String(opts.pageSize))
    }

    const queryString = params.toString()
    const path = `/blocks/${opts.blockId}/children${queryString ? `?${queryString}` : ''}`

    const response = yield* get(path, BlockChildrenResponseSchema)

    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionBlocks.retrieveChildren', {
      attributes: { 'notion.block_id': opts.blockId },
    }),
  )

/**
 * Retrieve block children with automatic pagination.
 *
 * Returns a stream that automatically fetches all pages.
 *
 * @see https://developers.notion.com/reference/get-block-children
 */
export const retrieveChildrenStream = (
  opts: Omit<RetrieveBlockChildrenOptions, 'startCursor'>,
): Stream.Stream<Block, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  paginatedStream((cursor) =>
    Effect.gen(function* () {
      const params = new URLSearchParams()

      if (Option.isSome(cursor)) {
        params.set('start_cursor', cursor.value)
      }

      if (opts.pageSize !== undefined) {
        params.set('page_size', String(opts.pageSize))
      }

      const queryString = params.toString()
      const path = `/blocks/${opts.blockId}/children${queryString ? `?${queryString}` : ''}`

      return yield* get(path, BlockChildrenResponseSchema)
    }),
  )

/**
 * Append children blocks to a parent block.
 *
 * @see https://developers.notion.com/reference/patch-block-children
 */
export const append = Effect.fn('NotionBlocks.append')(function* (
  opts: AppendBlockChildrenOptions,
) {
  const body: Record<string, unknown> = {
    children: opts.children,
  }

  if (opts.after !== undefined) {
    body.after = opts.after
  }

  return yield* patch(`/blocks/${opts.blockId}/children`, body, AppendBlockChildrenResponseSchema)
})

/**
 * Update a block.
 *
 * @see https://developers.notion.com/reference/update-a-block
 */
export const update = Effect.fn('NotionBlocks.update')(function* (opts: UpdateBlockOptions) {
  const { blockId, ...body } = opts

  return yield* patch(`/blocks/${blockId}`, body, BlockSchema)
})

/**
 * Delete (archive) a block.
 *
 * @see https://developers.notion.com/reference/delete-a-block
 */
export const deleteBlock = Effect.fn('NotionBlocks.delete')(function* (opts: DeleteBlockOptions) {
  return yield* del(`/blocks/${opts.blockId}`, BlockSchema)
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Blocks API */
export const NotionBlocks = {
  retrieve,
  retrieveChildren,
  retrieveChildrenStream,
  append,
  update,
  delete: deleteBlock,
} as const
