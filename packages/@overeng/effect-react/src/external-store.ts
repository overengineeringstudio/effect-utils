import { Effect, Fiber, Stream, SubscriptionRef } from 'effect'
import { useMemo, useSyncExternalStore } from 'react'

/** React-compatible external store contract for Effect-managed state. */
export interface EffectExternalStore<TSnapshot> {
  readonly getSnapshot: () => TSnapshot
  readonly subscribe: (onStoreChange: () => void) => () => void
}

/** Builds a React external store from Effect-based snapshot and change streams. */
export const makeEffectExternalStore = <TSnapshot>({
  getSnapshotEffect,
  changes,
}: {
  readonly getSnapshotEffect: Effect.Effect<TSnapshot>
  readonly changes: Stream.Stream<unknown>
}): EffectExternalStore<TSnapshot> => {
  const getSnapshot = (): TSnapshot => Effect.runSync(getSnapshotEffect)

  const subscribe = (onStoreChange: () => void): (() => void) => {
    const fiber = Effect.runFork(
      changes.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            onStoreChange()
          }),
        ),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }

  return { getSnapshot, subscribe }
}

/** Adapts a SubscriptionRef into a React external store. */
export const makeSubscriptionRefStore = <TSnapshot>(
  ref: SubscriptionRef.SubscriptionRef<TSnapshot>,
): EffectExternalStore<TSnapshot> =>
  makeEffectExternalStore({
    getSnapshotEffect: SubscriptionRef.get(ref),
    changes: ref.changes,
  })

/** Subscribes a component to an EffectExternalStore via useSyncExternalStore. */
export const useEffectExternalStore = <TSnapshot>(
  store: EffectExternalStore<TSnapshot>,
): TSnapshot => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

/** Subscribes a component directly to a SubscriptionRef. */
export const useSubscriptionRef = <TSnapshot>(
  ref: SubscriptionRef.SubscriptionRef<TSnapshot>,
): TSnapshot => {
  const store = useMemo(() => makeSubscriptionRefStore(ref), [ref])
  return useEffectExternalStore(store)
}
