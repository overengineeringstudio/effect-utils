import { Chunk, Effect, Option, Schema, Stream } from 'effect'

/**
 * Base schema for paginated responses from Notion API.
 */
export const PaginatedResponse = <A, I, R>(itemSchema: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    object: Schema.Literal('list'),
    results: Schema.Array(itemSchema),
    next_cursor: Schema.NullOr(Schema.String),
    has_more: Schema.Boolean,
  })

/** Shape of a paginated list response from the Notion API. */
export type PaginatedResponse<A> = {
  readonly object: 'list'
  readonly results: readonly A[]
  readonly next_cursor: string | null
  readonly has_more: boolean
}

/**
 * Create a paginated stream from a cursor-based API endpoint.
 *
 * Uses Stream.unfoldEffect to automatically fetch all pages.
 *
 * @param fetchPage - Function that fetches a single page given an optional cursor
 * @returns Stream of all items across all pages
 */
export const paginatedStream = <A, E, R>(
  fetchPage: (cursor: Option.Option<string>) => Effect.Effect<PaginatedResponse<A>, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.unfoldChunkEffect(Option.some(Option.none<string>()), (maybeNextCursor) =>
    Option.match(maybeNextCursor, {
      // No more pages - signal end
      onNone: () => Effect.succeed(Option.none()),
      // Fetch the page with the given cursor
      onSome: (cursor) =>
        fetchPage(cursor).pipe(
          Effect.map((response) => {
            const items = response.results as A[]
            const chunk = Chunk.fromIterable(items)

            if (response.has_more === false || response.next_cursor === null) {
              // Last page - emit items and signal no more pages
              return Option.some([chunk, Option.none()] as const)
            }

            // More pages - emit items and set next cursor
            return Option.some([chunk, Option.some(Option.some(response.next_cursor))] as const)
          }),
        ),
    }),
  )

/**
 * Helper to build query parameters for pagination.
 */
export const paginationParams = (opts: {
  startCursor?: string
  pageSize?: number
}): Record<string, string | number> => {
  const params: Record<string, string | number> = {}

  if (opts.startCursor !== undefined) {
    params.start_cursor = opts.startCursor
  }

  if (opts.pageSize !== undefined) {
    params.page_size = opts.pageSize
  }

  return params
}

/**
 * Helper type for paginated query options.
 */
export interface PaginationOptions {
  /** Cursor for the next page (from previous response) */
  readonly startCursor?: string
  /** Number of items per page (max 100, default varies by endpoint) */
  readonly pageSize?: number
}

/**
 * Response type including pagination metadata.
 */
export interface PaginatedResult<A> {
  /** Results from this page */
  readonly results: readonly A[]
  /** Cursor for next page, if more results exist */
  readonly nextCursor: Option.Option<string>
  /** Whether more results are available */
  readonly hasMore: boolean
}

/**
 * Convert raw paginated response to PaginatedResult.
 */
export const toPaginatedResult = <A>(response: PaginatedResponse<A>): PaginatedResult<A> => ({
  results: response.results,
  nextCursor: Option.fromNullable(response.next_cursor),
  hasMore: response.has_more,
})
