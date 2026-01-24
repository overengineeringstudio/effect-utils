/**
 * Generic Progress Service Factory
 *
 * Creates a SubscriptionRef-based progress service for tracking operation progress.
 * Provides clean separation between operation logic and UI rendering.
 *
 * @example
 * ```ts
 * // Create a typed progress service
 * const { Progress, ops, layer } = createProgressService<MyResultType>('my-operation')
 *
 * // Use in your command
 * const program = Effect.gen(function* () {
 *   yield* ops.init([{ id: 'item-1', label: 'Item 1' }])
 *   yield* ops.markActive('item-1', 'processing...')
 *   const result = yield* doWork()
 *   yield* ops.markSuccess('item-1', 'done')
 *   yield* ops.complete()
 * }).pipe(Effect.provide(layer))
 *
 * // Subscribe to changes for UI
 * const ui = Effect.gen(function* () {
 *   const changes = yield* ops.changes()
 *   yield* changes.pipe(Stream.runForEach(renderProgress))
 * })
 * ```
 */

import { Context, Effect, Layer, type Stream, SubscriptionRef } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** Status of a progress item */
export type ProgressItemStatus = 'pending' | 'active' | 'success' | 'error' | 'skipped'

/** A single item being tracked */
export type ProgressItem<TData = unknown> = {
  readonly id: string
  readonly label: string
  readonly status: ProgressItemStatus
  readonly message?: string | undefined
  readonly data?: TData | undefined
}

/** Overall progress state */
export type ProgressState<TData = unknown> = {
  /** All tracked items */
  readonly items: ReadonlyMap<string, ProgressItem<TData>>
  /** Start time (for elapsed calculation) */
  readonly startTime: number
  /** Whether the operation is complete */
  readonly isComplete: boolean
  /** Optional metadata */
  readonly metadata?: Record<string, unknown> | undefined
}

/** Input for creating a progress item */
export type ProgressItemInput<TData = unknown> = {
  readonly id: string
  readonly label: string
  readonly data?: TData | undefined
}

// =============================================================================
// State Helpers (Pure Functions)
// =============================================================================

/** Create an empty progress state */
export const emptyState = <TData>(): ProgressState<TData> => ({
  items: new Map(),
  startTime: Date.now(),
  isComplete: false,
})

/** Create initial state from items */
export const createState = <TData>({
  items,
  metadata,
}: {
  items: ReadonlyArray<ProgressItemInput<TData>>
  metadata?: Record<string, unknown>
}): ProgressState<TData> => ({
  items: new Map(
    items.map((item) => [
      item.id,
      {
        id: item.id,
        label: item.label,
        status: 'pending' as const,
        data: item.data,
      },
    ]),
  ),
  startTime: Date.now(),
  isComplete: false,
  metadata,
})

/** Update an item in the state */
export const updateItem = <TData>({
  state,
  id,
  update,
}: {
  state: ProgressState<TData>
  id: string
  update: Partial<Pick<ProgressItem<TData>, 'status' | 'message' | 'data'>>
}): ProgressState<TData> => {
  const existing = state.items.get(id)
  if (!existing) return state

  const newItems = new Map(state.items)
  newItems.set(id, { ...existing, ...update })
  return { ...state, items: newItems }
}

/** Add an item to the state */
export const addItem = <TData>({
  state,
  item,
}: {
  state: ProgressState<TData>
  item: ProgressItemInput<TData>
}): ProgressState<TData> => {
  if (state.items.has(item.id)) return state

  const newItems = new Map(state.items)
  newItems.set(item.id, {
    id: item.id,
    label: item.label,
    status: 'pending',
    data: item.data,
  })
  return { ...state, items: newItems }
}

/** Remove an item from the state */
export const removeItem = <TData>({
  state,
  id,
}: {
  state: ProgressState<TData>
  id: string
}): ProgressState<TData> => {
  if (!state.items.has(id)) return state

  const newItems = new Map(state.items)
  newItems.delete(id)
  return { ...state, items: newItems }
}

/** Mark state as complete */
export const markComplete = <TData>(state: ProgressState<TData>): ProgressState<TData> => ({
  ...state,
  isComplete: true,
})

// =============================================================================
// Query Helpers
// =============================================================================

/** Check if all items are done (not pending or active) */
export const isAllDone = <TData>(state: ProgressState<TData>): boolean => {
  for (const item of state.items.values()) {
    if (item.status === 'pending' || item.status === 'active') {
      return false
    }
  }
  return true
}

/** Get counts by status */
export const getStatusCounts = <TData>(
  state: ProgressState<TData>,
): Record<ProgressItemStatus, number> => {
  const counts: Record<ProgressItemStatus, number> = {
    pending: 0,
    active: 0,
    success: 0,
    error: 0,
    skipped: 0,
  }
  for (const item of state.items.values()) {
    counts[item.status]++
  }
  return counts
}

/** Get elapsed time in milliseconds */
export const getElapsed = <TData>(state: ProgressState<TData>): number =>
  Date.now() - state.startTime

/** Get items by status */
export const getItemsByStatus = <TData>({
  state,
  status,
}: {
  state: ProgressState<TData>
  status: ProgressItemStatus
}): ProgressItem<TData>[] => {
  const result: ProgressItem<TData>[] = []
  for (const item of state.items.values()) {
    if (item.status === status) {
      result.push(item)
    }
  }
  return result
}

// =============================================================================
// Service Factory
// =============================================================================

/**
 * Create a typed progress service.
 *
 * @param name - Unique name for the service (used in Context.Tag)
 * @returns Progress service with tag, operations, and layer factory
 */
export const createProgressService = <TData = unknown>(name: string) => {
  // Create the service tag
  type ProgressRef = SubscriptionRef.SubscriptionRef<ProgressState<TData>>

  class Progress extends Context.Tag(`megarepo/Progress/${name}`)<Progress, ProgressRef>() {}

  // Create operations that require the Progress service
  const ops = {
    init: ({
      items,
      metadata,
    }: {
      items: ReadonlyArray<ProgressItemInput<TData>>
      metadata?: Record<string, unknown>
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.set(ref, createState({ items, ...(metadata && { metadata }) }))
      }),

    markActive: ({
      id,
      message,
    }: {
      id: string
      message?: string
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) =>
          updateItem({ state, id, update: { status: 'active', message } }),
        )
      }),

    markSuccess: ({
      id,
      message,
    }: {
      id: string
      message?: string
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) =>
          updateItem({ state, id, update: { status: 'success', message } }),
        )
      }),

    markError: ({
      id,
      message,
    }: {
      id: string
      message?: string
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) =>
          updateItem({ state, id, update: { status: 'error', message } }),
        )
      }),

    markSkipped: ({
      id,
      message,
    }: {
      id: string
      message?: string
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) =>
          updateItem({ state, id, update: { status: 'skipped', message } }),
        )
      }),

    update: ({
      id,
      update,
    }: {
      id: string
      update: Partial<Pick<ProgressItem<TData>, 'status' | 'message' | 'data'>>
    }): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) => updateItem({ state, id, update }))
      }),

    addItem: (item: ProgressItemInput<TData>): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) => addItem({ state, item }))
      }),

    removeItem: (id: string): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, (state) => removeItem({ state, id }))
      }),

    complete: (): Effect.Effect<void, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        yield* SubscriptionRef.update(ref, markComplete)
      }),

    get: (): Effect.Effect<ProgressState<TData>, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        return yield* SubscriptionRef.get(ref)
      }),

    changes: (): Effect.Effect<Stream.Stream<ProgressState<TData>>, never, Progress> =>
      Effect.gen(function* () {
        const ref = yield* Progress
        return ref.changes
      }),
  }

  // Create layer factories
  const layer: Layer.Layer<Progress> = Layer.scoped(
    Progress,
    SubscriptionRef.make<ProgressState<TData>>(emptyState()),
  )

  const layerWith = (state: ProgressState<TData>): Layer.Layer<Progress> =>
    Layer.scoped(Progress, SubscriptionRef.make(state))

  return { Progress, ops, layer, layerWith }
}
