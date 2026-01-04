import { describe, it } from '@effect/vitest'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'
import { expect } from 'vitest'

import {
  type PaginatedResponse,
  paginatedStream,
  paginationParams,
  toPaginatedResult,
} from './pagination.ts'

class PaginationNetworkError extends Schema.TaggedError<PaginationNetworkError>()(
  'PaginationNetworkError',
  {
    message: Schema.String,
  },
) {}

describe('paginationParams', () => {
  it.effect('returns empty object when no options provided', () =>
    Effect.sync(() => {
      const params = paginationParams({})
      expect(params).toEqual({})
    }),
  )

  it.effect('includes start_cursor when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({ startCursor: 'cursor-abc' })
      expect(params).toEqual({ start_cursor: 'cursor-abc' })
    }),
  )

  it.effect('includes page_size when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({ pageSize: 50 })
      expect(params).toEqual({ page_size: 50 })
    }),
  )

  it.effect('includes both params when provided', () =>
    Effect.sync(() => {
      const params = paginationParams({ startCursor: 'cursor-xyz', pageSize: 25 })
      expect(params).toEqual({ start_cursor: 'cursor-xyz', page_size: 25 })
    }),
  )
})

describe('toPaginatedResult', () => {
  it.effect('converts response with next cursor', () =>
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

  it.effect('converts response without next cursor', () =>
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

  it.effect('handles empty results', () =>
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

describe('paginatedStream', () => {
  it.scoped('fetches single page when has_more is false', () =>
    Effect.gen(function* () {
      let fetchCount = 0

      const stream = paginatedStream((_cursor) =>
        Effect.sync(() => {
          fetchCount++
          return {
            object: 'list' as const,
            results: [{ id: '1' }, { id: '2' }],
            has_more: false,
            next_cursor: null,
          }
        }),
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: '1' }, { id: '2' }])
      expect(fetchCount).toBe(1)
    }),
  )

  it.scoped('fetches multiple pages with cursor', () =>
    Effect.gen(function* () {
      const cursors: Option.Option<string>[] = []

      const stream = paginatedStream((cursor) =>
        Effect.sync(() => {
          cursors.push(cursor)

          if (Option.isNone(cursor)) {
            // First page
            return {
              object: 'list' as const,
              results: [{ id: '1' }, { id: '2' }],
              has_more: true,
              next_cursor: 'cursor-page-2',
            }
          }

          if (cursor.value === 'cursor-page-2') {
            // Second page
            return {
              object: 'list' as const,
              results: [{ id: '3' }, { id: '4' }],
              has_more: true,
              next_cursor: 'cursor-page-3',
            }
          }

          // Last page
          return {
            object: 'list' as const,
            results: [{ id: '5' }],
            has_more: false,
            next_cursor: null,
          }
        }),
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }])
      expect(cursors.length).toBe(3)
      expect(Option.isNone(cursors[0] ?? Option.none())).toBe(true)
      expect(Option.getOrNull(cursors[1] ?? Option.none())).toBe('cursor-page-2')
      expect(Option.getOrNull(cursors[2] ?? Option.none())).toBe('cursor-page-3')
    }),
  )

  it.effect('handles empty first page', () =>
    Effect.gen(function* () {
      const stream = paginatedStream((_cursor) =>
        Effect.sync(() => ({
          object: 'list' as const,
          results: [] as { id: string }[],
          has_more: false,
          next_cursor: null,
        })),
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([])
    }),
  )

  it.effect('propagates errors from fetch function', () =>
    Effect.gen(function* () {
      const stream = paginatedStream((_cursor) =>
        Effect.fail(new PaginationNetworkError({ message: 'Network error' })),
      )

      const result = yield* Stream.runCollect(stream).pipe(Effect.flip)

      expect(result._tag).toBe('PaginationNetworkError')
      expect(result.message).toBe('Network error')
    }),
  )

  it.scoped('stops fetching after last page with items', () =>
    Effect.gen(function* () {
      let fetchCount = 0

      const stream = paginatedStream((cursor) =>
        Effect.sync(() => {
          fetchCount++

          if (Option.isNone(cursor)) {
            return {
              object: 'list' as const,
              results: [{ id: '1' }],
              has_more: true,
              next_cursor: 'cursor-2',
            }
          }

          // Last page - has items but no more pages
          return {
            object: 'list' as const,
            results: [{ id: '2' }],
            has_more: false,
            next_cursor: null,
          }
        }),
      )

      const items = yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

      expect(items).toEqual([{ id: '1' }, { id: '2' }])
      expect(fetchCount).toBe(2)
    }),
  )
})
