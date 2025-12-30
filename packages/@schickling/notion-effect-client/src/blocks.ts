import type { HttpClient } from '@effect/platform'
import { type Block, BlockSchema } from '@schickling/notion-effect-schema'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { del, get, patch } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
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

/** Internal helper to build query params for block children */
const buildBlockChildrenParams = (opts: RetrieveBlockChildrenOptions): string => {
  const params = new URLSearchParams()
  if (opts.startCursor !== undefined) params.set('start_cursor', opts.startCursor)
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize))
  return params.toString()
}

/** Internal raw retrieveChildren - used by both retrieveChildren and retrieveChildrenStream */
const retrieveChildrenRaw = (
  opts: RetrieveBlockChildrenOptions,
): Effect.Effect<PaginatedResult<Block>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const queryString = buildBlockChildrenParams(opts)
    const path = `/blocks/${opts.blockId}/children${queryString ? `?${queryString}` : ''}`
    const response = yield* get(path, BlockChildrenResponseSchema)
    return toPaginatedResult(response)
  }).pipe(
    Effect.withSpan('NotionBlocks.retrieveChildren', {
      attributes: { 'notion.block_id': opts.blockId },
    }),
  )

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
  retrieveChildrenRaw(opts)

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
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const childrenOpts: RetrieveBlockChildrenOptions = Option.isSome(cursor)
          ? { ...opts, startCursor: cursor.value }
          : { ...opts }
        return retrieveChildrenRaw(childrenOpts).pipe(
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
