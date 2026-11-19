import { Effect } from 'effect'
import type { FileSystem } from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import type { SchemaError } from 'effect/Schema'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import { type PoolError, type PoolSlot, readPoolState } from './store-pool-state.ts'

/** Recorded observation, never an action lease, cleanup proof or bearer capability. */
export type PoolRootProvenance = Readonly<Pick<PoolSlot,
  'id' | 'path' | 'bare' | 'commit' | 'sourceHistory' | 'generation' | 'state' | 'identity' | 'chargeKnown'
>> & {
  readonly authorizesRemoval: false
  readonly disposition: 'HOLD'
  readonly readyUnclaimed: boolean
  readonly ownerLabel: PoolSlot['owner']
  readonly ownerActivity: { readonly _tag: 'Unrecorded'; readonly source: 'canonical-pool-state-v2' }
  readonly claim: { readonly state: PoolSlot['state']; readonly tokenPresent: boolean }
  readonly reservationPresent: boolean
  readonly birth: Pick<NonNullable<PoolSlot['initialPreparation']>, 'generation' | 'commit'> | undefined
  readonly retarget: Pick<NonNullable<PoolSlot['retarget']>, 'from' | 'to'> | undefined
  readonly holdReasons: readonly ['owner-seat-activity-unrecorded', ...Array<'not-ready-unclaimed'>]
}

/** Current ready records discard the last owner and never record authenticated seat activity. */
export const projectPoolProvenance = (slot: PoolSlot): PoolRootProvenance => {
  const readyUnclaimed = slot.state === 'ready' && slot.chargeKnown === true &&
    slot.identity !== '' && slot.owner === '' && slot.token === '' &&
    slot.reservation === undefined && slot.initialPreparation === undefined && slot.retarget === undefined
  return {
    id: slot.id,
    path: slot.path,
    bare: slot.bare,
    commit: slot.commit,
    sourceHistory: slot.sourceHistory,
    generation: slot.generation,
    state: slot.state,
    identity: slot.identity,
    chargeKnown: slot.chargeKnown,
    authorizesRemoval: false,
    disposition: 'HOLD',
    readyUnclaimed,
    ownerLabel: slot.owner,
    ownerActivity: { _tag: 'Unrecorded', source: 'canonical-pool-state-v2' },
    claim: {
      state: slot.state,
      tokenPresent: slot.token !== '',
    },
    reservationPresent: slot.reservation !== undefined,
    birth: slot.initialPreparation === undefined ? undefined : {
      generation: slot.initialPreparation.generation, commit: slot.initialPreparation.commit,
    },
    retarget: slot.retarget === undefined ? undefined : { from: slot.retarget.from, to: slot.retarget.to },
    holdReasons: readyUnclaimed === true
      ? ['owner-seat-activity-unrecorded']
      : ['owner-seat-activity-unrecorded', 'not-ready-unclaimed'],
  }
}

/** No initialization, migration writes, recovery, liveness probes, unlocking or removal. */
export const readPoolProvenance = ({ base }: { base: AbsoluteDirPath }): Effect.Effect<
  ReadonlyArray<PoolRootProvenance>, PoolError | PlatformError | SchemaError, FileSystem
> => readPoolState({ base }).pipe(Effect.map((state) => state.slots.map(projectPoolProvenance)))
