import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'

import { type Comment, CommentSchema } from '@overeng/notion-effect-schema'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get, post } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'

/** Comments list response */
const CommentsResponseSchema = PaginatedResponse(CommentSchema)

/** Create comment response */
const CreateCommentResponseSchema = CommentSchema

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parent for a new comment */
export type CommentParentInput =
  | { readonly type: 'page_id'; readonly page_id: string }
  | { readonly type: 'block_id'; readonly block_id: string }

/** Options for creating a comment */
export interface CreateCommentOptions {
  /** Parent page or block */
  readonly parent: CommentParentInput
  /** Rich text content (mutually exclusive with markdown) */
  readonly rich_text?: readonly unknown[]
  /** Markdown content (mutually exclusive with rich_text) */
  readonly markdown?: string
  /** Discussion ID to reply to an existing thread */
  readonly discussion_id?: string
}

/** Options for listing comments */
export interface ListCommentsOptions extends PaginationOptions {
  /** Block ID to list comments for */
  readonly blockId: string
}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Create a comment on a page or block.
 *
 * @see https://developers.notion.com/reference/create-comment
 */
export const create = Effect.fn('NotionComments.create')(function* (opts: CreateCommentOptions) {
  const body: Record<string, unknown> = {
    parent: opts.parent,
  }

  if (opts.rich_text !== undefined) {
    body.rich_text = opts.rich_text
  }

  if (opts.markdown !== undefined) {
    body.markdown = opts.markdown
  }

  if (opts.discussion_id !== undefined) {
    body.discussion_id = opts.discussion_id
  }

  return yield* post({
    path: '/comments',
    body,
    responseSchema: CreateCommentResponseSchema,
  })
})

/** Internal helper to build query params for listing comments */
const buildListParams = (opts: ListCommentsOptions): string => {
  const params = new URLSearchParams()
  params.set('block_id', opts.blockId)
  if (opts.startCursor !== undefined) params.set('start_cursor', opts.startCursor)
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize))
  return params.toString()
}

/** Internal raw list */
const listRaw = Effect.fn('NotionComments.list')(function* (opts: ListCommentsOptions) {
  const queryString = buildListParams(opts)
  const response = yield* get({
    path: `/comments?${queryString}`,
    responseSchema: CommentsResponseSchema,
  })
  return toPaginatedResult(response)
})

/**
 * List comments on a block or page.
 *
 * @see https://developers.notion.com/reference/retrieve-a-comment
 */
export const list = (
  opts: ListCommentsOptions,
): Effect.Effect<PaginatedResult<Comment>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  listRaw(opts)

/**
 * List all comments with automatic pagination.
 *
 * @see https://developers.notion.com/reference/retrieve-a-comment
 */
export const listStream = (
  opts: Omit<ListCommentsOptions, 'startCursor'>,
): Stream.Stream<Comment, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const listOpts: ListCommentsOptions =
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

/** Notion Comments API */
export const NotionComments = {
  create,
  list,
  listStream,
} as const
