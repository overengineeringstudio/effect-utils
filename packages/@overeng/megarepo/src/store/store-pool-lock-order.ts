import { Context, Effect } from 'effect'

// Private and fiber-local: another root may do physical work while this epoch is held.
const PoolGlobalEpoch = Context.Reference<boolean>('megarepo/PoolGlobalEpoch', {
  defaultValue: () => false,
})

/** Only the ledger owner scopes this around its short state callback, not physical work. */
export const withPoolGlobalEpoch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, PoolGlobalEpoch, true)

/** Refuse reverse acquisitions before native admission, preserving each owner's error type. */
export const requireOutsidePoolGlobal = <E>(refusal: () => E): Effect.Effect<void, E> =>
  Effect.flatMap(PoolGlobalEpoch, (active) =>
    active === true ? Effect.fail(refusal()) : Effect.void,
  )
