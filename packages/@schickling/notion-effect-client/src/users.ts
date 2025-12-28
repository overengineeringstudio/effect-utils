import type { HttpClient } from '@effect/platform'
import { Effect, Option, Schema, type Stream } from 'effect'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { get } from './internal/http.ts'
import {
  PaginatedResponse,
  type PaginatedResult,
  type PaginationOptions,
  paginatedStream,
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
  return yield* get(`/users/${opts.userId}`, UserSchema)
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
  Effect.gen(function* () {
    const params = new URLSearchParams()

    if (opts.startCursor !== undefined) {
      params.set('start_cursor', opts.startCursor)
    }

    if (opts.pageSize !== undefined) {
      params.set('page_size', String(opts.pageSize))
    }

    const queryString = params.toString()
    const path = `/users${queryString ? `?${queryString}` : ''}`

    const response = yield* get(path, ListUsersResponseSchema)

    return toPaginatedResult(response)
  }).pipe(Effect.withSpan('NotionUsers.list'))

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
      const path = `/users${queryString ? `?${queryString}` : ''}`

      return yield* get(path, ListUsersResponseSchema)
    }),
  )

/**
 * Retrieve the bot user associated with the integration token.
 *
 * @see https://developers.notion.com/reference/get-self
 */
export const me = Effect.fn('NotionUsers.me')(function* () {
  return yield* get('/users/me', BotUserSchema)
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
