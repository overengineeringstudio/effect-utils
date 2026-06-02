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

/**
 * Fetch one page in the mapped `PaginatedResult` shape, keyed by cursor.
 *
 * `Page` may be a structural superset of `PaginatedResult<…>` (e.g. carrying
 * an extra `propertyItem` field), so the `'page'` emit mapper sees the concrete
 * fetched result, not just the base pagination envelope.
 */
export type FetchPage<Page extends PaginatedResult<unknown>, E, R> = (
  cursor: Option.Option<string>,
) => Effect.Effect<Page, E, R>

/** How each fetched page becomes stream output. */
export type PaginateEmit<Page extends PaginatedResult<unknown>, Out> =
  | { readonly _tag: 'items' }
  | { readonly _tag: 'page'; readonly map: (page: Page) => Out }

/** Options controlling cursor seeding and per-page emit granularity for {@link paginate}. */
export interface PaginateOptions<Page extends PaginatedResult<unknown>, Out> {
  /** Cursor to begin from. Default: `Option.none()` (start from the beginning). */
  readonly startCursor?: Option.Option<string>
  /**
   * How each page becomes stream output:
   * - `{ _tag: 'items' }` flattens `page.results` (`Out = Page['results'][number]`).
   * - `{ _tag: 'page', map }` emits one `Out` per page via `map`.
   */
  readonly emit: PaginateEmit<Page, Out>
}

/**
 * Stream every page of a cursor-paginated Notion endpoint, built on the mapped
 * `PaginatedResult` shape. Supports an optional initial cursor and either
 * flatten-items or emit-one-value-per-page output.
 */
// oxlint-disable-next-line overeng/named-args -- primary fetch function plus pagination options.
export const paginate = <Page extends PaginatedResult<unknown>, Out, E, R>(
  fetchPage: FetchPage<Page, E, R>,
  options: PaginateOptions<Page, Out>,
): Stream.Stream<Out, E, R> =>
  Stream.unfoldChunkEffect(Option.some(options.startCursor ?? Option.none<string>()), (state) =>
    Option.match(state, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (cursor) =>
        fetchPage(cursor).pipe(
          Effect.map((page) => {
            const chunk =
              options.emit._tag === 'items'
                ? // In 'items' mode `Out` is the page's element type, but the
                  // tag union prevents TS from narrowing it here.
                  (Chunk.fromIterable(page.results) as unknown as Chunk.Chunk<Out>)
                : Chunk.of(options.emit.map(page))
            const done = page.hasMore === false || Option.isNone(page.nextCursor) === true
            return Option.some([
              chunk,
              done === true ? Option.none() : Option.some(Option.some(page.nextCursor.value)),
            ] as const)
          }),
        ),
    }),
  )
