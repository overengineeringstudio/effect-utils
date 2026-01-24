import { Effect, Stream, Chunk } from 'effect'
import { describe, it, expect } from 'vitest'

import {
  createProgressService,
  emptyState,
  createState,
  updateItem,
  addItem,
  removeItem,
  markComplete,
  isAllDone,
  getStatusCounts,
  getItemsByStatus,
  type ProgressItemInput,
} from './service.ts'

// =============================================================================
// State Helper Tests
// =============================================================================

describe('progress service state helpers', () => {
  describe('emptyState', () => {
    it('creates an empty state', () => {
      const state = emptyState()

      expect(state.items.size).toBe(0)
      expect(state.isComplete).toBe(false)
      expect(state.startTime).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('createState', () => {
    it('creates state with pending items', () => {
      const items: ProgressItemInput[] = [
        { id: 'item-1', label: 'Item 1' },
        { id: 'item-2', label: 'Item 2' },
      ]

      const state = createState(items)

      expect(state.items.size).toBe(2)
      expect(state.items.get('item-1')?.status).toBe('pending')
      expect(state.items.get('item-2')?.status).toBe('pending')
      expect(state.isComplete).toBe(false)
    })

    it('creates state with metadata', () => {
      const state = createState([], { foo: 'bar' })

      expect(state.metadata).toEqual({ foo: 'bar' })
    })

    it('creates state with data attached to items', () => {
      type MyData = { value: number }
      const items: ProgressItemInput<MyData>[] = [
        { id: 'item-1', label: 'Item 1', data: { value: 42 } },
      ]

      const state = createState(items)

      expect(state.items.get('item-1')?.data).toEqual({ value: 42 })
    })
  })

  describe('updateItem', () => {
    it('updates existing item status', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = updateItem(state, 'item-1', { status: 'active', message: 'working...' })

      expect(updated.items.get('item-1')?.status).toBe('active')
      expect(updated.items.get('item-1')?.message).toBe('working...')
    })

    it('returns same state for non-existent item', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = updateItem(state, 'non-existent', { status: 'success' })

      expect(updated).toBe(state)
    })

    it('preserves other item properties when updating', () => {
      type MyData = { value: number }
      const state = createState<MyData>([{ id: 'item-1', label: 'Item 1', data: { value: 42 } }])

      const updated = updateItem(state, 'item-1', { status: 'success' })

      expect(updated.items.get('item-1')?.data).toEqual({ value: 42 })
      expect(updated.items.get('item-1')?.label).toBe('Item 1')
    })
  })

  describe('addItem', () => {
    it('adds a new item', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = addItem(state, { id: 'item-2', label: 'Item 2' })

      expect(updated.items.size).toBe(2)
      expect(updated.items.get('item-2')?.status).toBe('pending')
    })

    it('returns same state if item already exists', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = addItem(state, { id: 'item-1', label: 'Different Label' })

      expect(updated).toBe(state)
    })
  })

  describe('removeItem', () => {
    it('removes an existing item', () => {
      const state = createState([
        { id: 'item-1', label: 'Item 1' },
        { id: 'item-2', label: 'Item 2' },
      ])

      const updated = removeItem(state, 'item-1')

      expect(updated.items.size).toBe(1)
      expect(updated.items.has('item-1')).toBe(false)
    })

    it('returns same state if item does not exist', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = removeItem(state, 'non-existent')

      expect(updated).toBe(state)
    })
  })

  describe('markComplete', () => {
    it('marks state as complete', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      const updated = markComplete(state)

      expect(updated.isComplete).toBe(true)
    })
  })
})

// =============================================================================
// Query Helper Tests
// =============================================================================

describe('progress service query helpers', () => {
  describe('isAllDone', () => {
    it('returns false when items are pending', () => {
      const state = createState([{ id: 'item-1', label: 'Item 1' }])

      expect(isAllDone(state)).toBe(false)
    })

    it('returns false when items are active', () => {
      let state = createState([{ id: 'item-1', label: 'Item 1' }])
      state = updateItem(state, 'item-1', { status: 'active' })

      expect(isAllDone(state)).toBe(false)
    })

    it('returns true when all items are success', () => {
      let state = createState([
        { id: 'item-1', label: 'Item 1' },
        { id: 'item-2', label: 'Item 2' },
      ])
      state = updateItem(state, 'item-1', { status: 'success' })
      state = updateItem(state, 'item-2', { status: 'success' })

      expect(isAllDone(state)).toBe(true)
    })

    it('returns true when items are error or skipped', () => {
      let state = createState([
        { id: 'item-1', label: 'Item 1' },
        { id: 'item-2', label: 'Item 2' },
      ])
      state = updateItem(state, 'item-1', { status: 'error' })
      state = updateItem(state, 'item-2', { status: 'skipped' })

      expect(isAllDone(state)).toBe(true)
    })

    it('returns true for empty state', () => {
      const state = createState([])

      expect(isAllDone(state)).toBe(true)
    })
  })

  describe('getStatusCounts', () => {
    it('counts items by status', () => {
      let state = createState([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
        { id: 'e', label: 'E' },
      ])
      state = updateItem(state, 'b', { status: 'active' })
      state = updateItem(state, 'c', { status: 'success' })
      state = updateItem(state, 'd', { status: 'error' })
      state = updateItem(state, 'e', { status: 'skipped' })

      const counts = getStatusCounts(state)

      expect(counts.pending).toBe(1)
      expect(counts.active).toBe(1)
      expect(counts.success).toBe(1)
      expect(counts.error).toBe(1)
      expect(counts.skipped).toBe(1)
    })
  })

  describe('getItemsByStatus', () => {
    it('returns items with matching status', () => {
      let state = createState([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ])
      state = updateItem(state, 'a', { status: 'success' })
      state = updateItem(state, 'c', { status: 'success' })

      const successItems = getItemsByStatus(state, 'success')

      expect(successItems).toHaveLength(2)
      expect(successItems.map((i) => i.id)).toContain('a')
      expect(successItems.map((i) => i.id)).toContain('c')
    })

    it('returns empty array when no items match', () => {
      const state = createState([{ id: 'a', label: 'A' }])

      const errorItems = getItemsByStatus(state, 'error')

      expect(errorItems).toHaveLength(0)
    })
  })
})

// =============================================================================
// Service Factory Tests
// =============================================================================

describe('createProgressService', () => {
  it('creates a typed progress service', () => {
    const { Progress, ops, layer } = createProgressService<{ value: number }>('test-progress')

    expect(Progress).toBeDefined()
    expect(ops).toBeDefined()
    expect(layer).toBeDefined()
  })

  describe('service operations', () => {
    const { ops, layer } = createProgressService<{ value: number }>('test-ops')

    it('init initializes state', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([
            { id: 'item-1', label: 'Item 1', data: { value: 1 } },
            { id: 'item-2', label: 'Item 2', data: { value: 2 } },
          ])
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.size).toBe(2)
      expect(result.items.get('item-1')?.data).toEqual({ value: 1 })
    })

    it('markActive updates item to active status', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.markActive('item-1', 'processing...')
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.get('item-1')?.status).toBe('active')
      expect(result.items.get('item-1')?.message).toBe('processing...')
    })

    it('markSuccess updates item to success status', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.markSuccess('item-1', 'done')
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.get('item-1')?.status).toBe('success')
      expect(result.items.get('item-1')?.message).toBe('done')
    })

    it('markError updates item to error status', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.markError('item-1', 'failed')
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.get('item-1')?.status).toBe('error')
      expect(result.items.get('item-1')?.message).toBe('failed')
    })

    it('markSkipped updates item to skipped status', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.markSkipped('item-1', 'not needed')
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.get('item-1')?.status).toBe('skipped')
      expect(result.items.get('item-1')?.message).toBe('not needed')
    })

    it('update allows partial updates', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.update('item-1', { status: 'success', data: { value: 99 } })
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.get('item-1')?.status).toBe('success')
      expect(result.items.get('item-1')?.data).toEqual({ value: 99 })
    })

    it('addItem adds a new item', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
          yield* ops.addItem({ id: 'item-2', label: 'Item 2', data: { value: 2 } })
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.size).toBe(2)
      expect(result.items.get('item-2')?.data).toEqual({ value: 2 })
    })

    it('removeItem removes an item', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([
            { id: 'item-1', label: 'Item 1' },
            { id: 'item-2', label: 'Item 2' },
          ])
          yield* ops.removeItem('item-1')
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.items.size).toBe(1)
      expect(result.items.has('item-1')).toBe(false)
    })

    it('complete marks state as complete', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([])
          yield* ops.complete()
          return yield* ops.get()
        }).pipe(Effect.provide(layer)),
      )

      expect(result.isComplete).toBe(true)
    })

    it('changes returns a stream of state updates', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ops.init([{ id: 'item-1', label: 'Item 1' }])

          const changes = yield* ops.changes()
          const firstState = yield* changes.pipe(Stream.take(1), Stream.runCollect)

          return Chunk.toArray(firstState)[0]
        }).pipe(Effect.provide(layer)),
      )

      expect(result?.items.get('item-1')?.status).toBe('pending')
    })
  })

  describe('multiple service instances', () => {
    it('creates independent services with different names', async () => {
      const service1 = createProgressService<string>('service-1')
      const service2 = createProgressService<string>('service-2')

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* service1.ops.init([{ id: 'a', label: 'A', data: 'from-1' }])
          yield* service2.ops.init([{ id: 'b', label: 'B', data: 'from-2' }])

          const state1 = yield* service1.ops.get()
          const state2 = yield* service2.ops.get()

          return { state1, state2 }
        }).pipe(Effect.provide(service1.layer), Effect.provide(service2.layer)),
      )

      expect(result.state1.items.get('a')?.data).toBe('from-1')
      expect(result.state2.items.get('b')?.data).toBe('from-2')
      expect(result.state1.items.has('b')).toBe(false)
      expect(result.state2.items.has('a')).toBe(false)
    })
  })

  describe('layerWith', () => {
    it('creates layer with initial state', async () => {
      const { ops, layerWith } = createProgressService<string>('test-layer-with')

      const initialState = createState([{ id: 'pre-existing', label: 'Pre-existing', data: 'x' }])
      const customLayer = layerWith(initialState)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ops.get()
        }).pipe(Effect.provide(customLayer)),
      )

      expect(result.items.size).toBe(1)
      expect(result.items.get('pre-existing')?.data).toBe('x')
    })
  })
})
