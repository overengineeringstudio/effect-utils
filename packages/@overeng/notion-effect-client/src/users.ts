import type { HttpClient } from '@effect/platform'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'

import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  toPaginatedResult,
} from './internal/pagination.ts'

// -----------------------------------------------------------------------------
// Temporary schemas until we connect to the schema package
// -----------------------------------------------------------------------------

/** Placeholder for User schema - allows any additional properties */
const UserSchema = Schema.Struct({
  object: Schema.Literal('user'),
  id: Schema.String,
}).annotations({ identifier: 'User' })

type User = typeof UserSchema.Type

/** Users list response */
const ListUsersResponseSchema = PaginatedResponse(UserSchema)

/** Bot user response (same as User) */
const BotUserSchema = UserSchema

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for retrieving a user */
export interface RetrieveUserOptions {
  /** User ID to retrieve */
  readonly userId: string
}

/** Options for listing users */
export interface ListUsersOptions extends PaginationOptions {}

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Retrieve a user by ID.
 *
 * @see https://developers.notion.com/reference/get-user
 */
export const retrieve = Effect.fn('NotionUsers.retrieve')(function* (opts: RetrieveUserOptions) {
  return yield* get({
    path: `/users/${opts.userId}`,
    responseSchema: UserSchema,
  })
})

/** Internal helper to build query params */
const buildListParams = (opts: ListUsersOptions): string => {
  const params = new URLSearchParams()
  if (opts.startCursor !== undefined) params.set('start_cursor', opts.startCursor)
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize))
  return params.toString()
}

/** Internal raw list - used by both list and listStream */
const listRaw = Effect.fn('NotionUsers.list')(function* (opts: ListUsersOptions) {
  const queryString = buildListParams(opts)
  const path = `/users${queryString ? `?${queryString}` : ''}`
  const response = yield* get({
    path,
    responseSchema: ListUsersResponseSchema,
  })
  return toPaginatedResult(response)
})

/**
 * List all users with pagination.
 *
 * Returns a single page of results with cursor for next page.
 *
 * @see https://developers.notion.com/reference/get-users
 */
export const list = (
  opts: ListUsersOptions = {},
): Effect.Effect<PaginatedResult<User>, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  listRaw(opts)

/**
 * List all users with automatic pagination.
 *
 * Returns a stream that automatically fetches all pages.
 *
 * @see https://developers.notion.com/reference/get-users
 */
export const listStream = (
  opts: Omit<ListUsersOptions, 'startCursor'> = {},
): Stream.Stream<User, NotionApiError, NotionConfig | HttpClient.HttpClient> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) => {
        const listOpts: ListUsersOptions = Option.isSome(cursor)
          ? { ...opts, startCursor: cursor.value }
          : { ...opts }
        return listRaw(listOpts).pipe(
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
 * Retrieve the bot user associated with the integration token.
 *
 * @see https://developers.notion.com/reference/get-self
 */
export const me = Effect.fn('NotionUsers.me')(function* () {
  return yield* get({ path: '/users/me', responseSchema: BotUserSchema })
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Users API */
export const NotionUsers = {
  retrieve,
  list,
  listStream,
  me,
} as const
