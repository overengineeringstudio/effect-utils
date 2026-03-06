import { Effect, Fiber, Stream, SubscriptionRef } from 'effect'
import { useMemo, useSyncExternalStore } from 'react'

export interface EffectExternalStore<TSnapshot> {
  readonly getSnapshot: () => TSnapshot
  readonly subscribe: (onStoreChange: () => void) => () => void
}

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

export const makeSubscriptionRefStore = <TSnapshot>(
  ref: SubscriptionRef.SubscriptionRef<TSnapshot>,
): EffectExternalStore<TSnapshot> =>
  makeEffectExternalStore({
    getSnapshotEffect: SubscriptionRef.get(ref),
    changes: ref.changes,
  })

export const useEffectExternalStore = <TSnapshot>(
  store: EffectExternalStore<TSnapshot>,
): TSnapshot => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

export const useSubscriptionRef = <TSnapshot>(
  ref: SubscriptionRef.SubscriptionRef<TSnapshot>,
): TSnapshot => {
  const store = useMemo(() => makeSubscriptionRefStore(ref), [ref])
  return useEffectExternalStore(store)
}
