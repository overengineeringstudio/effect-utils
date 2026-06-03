import { Chunk, Effect, Option, Schema, Stream } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  type PaginatedResponse,
  type PaginatedResult,
  paginate,
  paginationParams,
  toPaginatedResult,
} from './pagination.ts'

class PaginationNetworkError extends Schema.TaggedError<PaginationNetworkError>()(
  'PaginationNetworkError',
  {
    message: Schema.String,
  },
) {}

Vitest.describe('paginationParams', () => {
  Vitest.it.effect('returns empty object when no options provided', () =>
    Effect.sync(() => {
      const params = paginationParams({})
      expect(params).toEqual({})
    }),
  )

  Vitest.it.effect('includes start_cursor when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({ startCursor: 'cursor-abc' })
      expect(params).toEqual({ start_cursor: 'cursor-abc' })
    }),
  )

  Vitest.it.effect('includes page_size when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({ pageSize: 50 })
      expect(params).toEqual({ page_size: 50 })
    }),
  )

  Vitest.it.effect('includes both params when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({
        startCursor: 'cursor-xyz',
        pageSize: 25,
      })
      expect(params).toEqual({ start_cursor: 'cursor-xyz', page_size: 25 })
    }),
  )
})

Vitest.describe('toPaginatedResult', () => {
  Vitest.it.effect('converts response with next cursor', () =>
    Effect.sync(() => {
      const response: PaginatedResponse<{ id: string }> = {
        object: 'list',
        results: [{ id: '1' }, { id: '2' }],
        has_more: true,
        next_cursor: 'cursor-next',
      }

      const result = toPaginatedResult(response)

      expect(result.results).toEqual([{ id: '1' }, { id: '2' }])
      expect(result.hasMore).toBe(true)
      expect(Option.isSome(result.nextCursor)).toBe(true)
      expect(Option.getOrNull(result.nextCursor)).toBe('cursor-next')
    }),
  )

  Vitest.it.effect('converts response without next cursor', () =>
    Effect.sync(() => {
      const response: PaginatedResponse<{ id: string }> = {
        object: 'list',
        results: [{ id: '1' }],
        has_more: false,
        next_cursor: null,
      }

      const result = toPaginatedResult(response)

      expect(result.results).toEqual([{ id: '1' }])
      expect(result.hasMore).toBe(false)
      expect(Option.isNone(result.nextCursor)).toBe(true)
    }),
  )

  Vitest.it.effect('handles empty results', () =>
    Effect.sync(() => {
      const response: PaginatedResponse<{ id: string }> = {
        object: 'list',
        results: [],
        has_more: false,
        next_cursor: null,
      }

      const result = toPaginatedResult(response)

      expect(result.results).toEqual([])
      expect(result.hasMore).toBe(false)
      expect(Option.isNone(result.nextCursor)).toBe(true)
    }),
  )
})

const pageResult = <A>(input: {
  results: readonly A[]
  nextCursor?: string
}): PaginatedResult<A> => ({
  results: input.results,
  nextCursor: Option.fromNullable(input.nextCursor),
  hasMore: input.nextCursor !== undefined,
})

Vitest.describe('paginate (items mode)', () => {
  Vitest.it.scoped('fetches single page when hasMore is false', () =>
    Effect.gen(function* () {
      let fetchCount = 0

      const stream = paginate(
        (_cursor) =>
          Effect.sync(() => {
            fetchCount++
            return pageResult({ results: [{ id: '1' }, { id: '2' }] })
          }),
        { emit: { _tag: 'items' } },
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: '1' }, { id: '2' }])
      expect(fetchCount).toBe(1)
    }),
  )

  Vitest.it.scoped('flattens multiple pages and threads the cursor', () =>
    Effect.gen(function* () {
      const cursors: Option.Option<string>[] = []

      const stream = paginate(
        (cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            if (Option.isNone(cursor) === true) {
              return pageResult({
                results: [{ id: '1' }, { id: '2' }],
                nextCursor: 'cursor-page-2',
              })
            }
            if (cursor.value === 'cursor-page-2') {
              return pageResult({
                results: [{ id: '3' }, { id: '4' }],
                nextCursor: 'cursor-page-3',
              })
            }
            return pageResult({ results: [{ id: '5' }] })
          }),
        { emit: { _tag: 'items' } },
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }])
      expect(cursors.length).toBe(3)
      expect(Option.isNone(cursors[0] ?? Option.none())).toBe(true)
      expect(Option.getOrNull(cursors[1] ?? Option.none())).toBe('cursor-page-2')
      expect(Option.getOrNull(cursors[2] ?? Option.none())).toBe('cursor-page-3')
    }),
  )

  Vitest.it.scoped('seeds the first fetch with the provided start cursor', () =>
    Effect.gen(function* () {
      const cursors: Option.Option<string>[] = []

      const stream = paginate(
        (cursor) =>
          Effect.sync(() => {
            cursors.push(cursor)
            return pageResult({ results: [{ id: 'a' }] })
          }),
        { startCursor: Option.some('seed-cursor'), emit: { _tag: 'items' } },
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: 'a' }])
      expect(Option.getOrNull(cursors[0] ?? Option.none())).toBe('seed-cursor')
    }),
  )

  Vitest.it.effect('propagates errors from the fetch function', () =>
    Effect.gen(function* () {
      const stream = paginate(
        (_cursor) => Effect.fail(new PaginationNetworkError({ message: 'Network error' })),
        { emit: { _tag: 'items' } },
      )

      const result = yield* Stream.runCollect(stream).pipe(Effect.flip)

      expect(result._tag).toBe('PaginationNetworkError')
      expect(result.message).toBe('Network error')
    }),
  )
})

Vitest.describe('paginate (page mode)', () => {
  Vitest.it.scoped('emits one mapped value per page without flattening', () =>
    Effect.gen(function* () {
      const stream = paginate(
        (cursor) =>
          Effect.sync(() =>
            Option.isNone(cursor) === true
              ? pageResult({ results: [{ id: '1' }, { id: '2' }], nextCursor: 'cursor-2' })
              : pageResult({ results: [{ id: '3' }] }),
          ),
        { emit: { _tag: 'page', map: (page) => page.results.length } },
      )

      const pages = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(pages).toEqual([2, 1])
    }),
  )
})
