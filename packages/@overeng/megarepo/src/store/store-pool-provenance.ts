import { Effect, Schema } from 'effect'
import type { FileSystem } from 'effect/FileSystem'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import { type PoolActivity, type PoolActivityEvent, type PoolSlot, readPoolState, validPoolActivity } from './store-pool-state.ts'

/** Public observations never forward private ledger diagnostics or capability-bearing causes. */
export class PoolProvenanceUnavailableError extends Schema.TaggedError<PoolProvenanceUnavailableError>()(
  'PoolProvenanceUnavailableError',
  { message: Schema.Literal('Authoritative pool provenance is unavailable') },
) {}

type PublicActivityEvent = Readonly<Pick<PoolActivityEvent, 'observedAtUtc' | 'ownerLabel' | 'ownerLabelOrigin'>> & {
  readonly provider: Readonly<Pick<PoolActivityEvent['provider'], 'pid' | 'uid' | 'processStartTime'>>
  readonly providerIdentityComplete: boolean
}
type RecordedRootActivity = Readonly<Pick<PoolActivity, 'generation' | 'commit' | 'identity' | 'phase'>> & {
  readonly _tag: 'Recorded'
  readonly source: 'canonical-pool-state-v2'
  readonly authenticatedSeat: false
  readonly event: PublicActivityEvent
  readonly claimed: PublicActivityEvent | undefined
  readonly completed: PublicActivityEvent | undefined
}
type TerminalRootActivity = {
  readonly kind: 'birth' | 'claim-release'
  readonly observedAtUtc: string
}
type HoldReason = 'owner-seat-activity-unrecorded' | 'not-ready-unclaimed' |
  'root-activity-invalid' | 'terminal-root-history-incomplete'

const providerRecorded = (event: PoolActivityEvent) =>
  event.provider.uid !== undefined && event.provider.processStartTime !== undefined
const projectActivityEvent = (event: PoolActivityEvent): PublicActivityEvent => ({
  observedAtUtc: event.observedAtUtc,
  ownerLabel: event.ownerLabel,
  ownerLabelOrigin: event.ownerLabelOrigin,
  provider: {
    pid: event.provider.pid, uid: event.provider.uid, processStartTime: event.provider.processStartTime,
  },
  providerIdentityComplete: providerRecorded(event),
})

/** Recorded observation, never an action lease, cleanup proof or bearer capability. */
export type PoolRootProvenance = Readonly<Pick<PoolSlot,
  'id' | 'path' | 'bare' | 'commit' | 'sourceHistory' | 'generation' | 'state' | 'identity' | 'chargeKnown'
>> & {
  readonly authorizesRemoval: false
  readonly disposition: 'CANDIDATE' | 'HOLD'
  readonly readyUnclaimed: boolean
  readonly ownerLabel: PoolSlot['owner']
  readonly ownerActivity: RecordedRootActivity |
    { readonly _tag: 'Unrecorded'; readonly source: 'canonical-pool-state-v2' }
  readonly terminalRootActivity: TerminalRootActivity | undefined
  readonly claim: { readonly state: PoolSlot['state']; readonly tokenPresent: boolean }
  readonly reservationPresent: boolean
  readonly birth: Pick<NonNullable<PoolSlot['initialPreparation']>, 'generation' | 'commit'> | undefined
  readonly retarget: Pick<NonNullable<PoolSlot['retarget']>, 'from' | 'to'> | undefined
  readonly holdReasons: ReadonlyArray<HoldReason>
}

/** Candidates have recorded terminal root history, never authenticated seat or deletion authority. */
export const projectPoolProvenance = (slot: PoolSlot): PoolRootProvenance => {
  const readyUnclaimed = slot.state === 'ready' && slot.chargeKnown === true &&
    slot.identity !== '' && slot.owner === '' && slot.token === '' &&
    slot.reservation === undefined && slot.initialPreparation === undefined && slot.retarget === undefined
  const activity = slot.activity
  const activityValid = validPoolActivity(slot)
  let terminalRootActivity: TerminalRootActivity | undefined
  if (activity !== undefined && activityValid === true && providerRecorded(activity.event) === true) {
    if (activity.phase === 'birth-ready') {
      terminalRootActivity = { kind: 'birth', observedAtUtc: activity.event.observedAtUtc }
    } else if (activity.phase === 'release-ready' &&
      activity.claimed !== undefined && activity.completed !== undefined &&
      providerRecorded(activity.claimed) === true && providerRecorded(activity.completed) === true &&
      Date.parse(activity.claimed.observedAtUtc) <= Date.parse(activity.completed.observedAtUtc) &&
      Date.parse(activity.completed.observedAtUtc) <= Date.parse(activity.event.observedAtUtc)) {
      terminalRootActivity = { kind: 'claim-release', observedAtUtc: activity.event.observedAtUtc }
    }
  }
  const holdReasons: Array<HoldReason> = []
  if (readyUnclaimed === false) holdReasons.push('not-ready-unclaimed')
  if (activity === undefined) holdReasons.push('owner-seat-activity-unrecorded')
  else if (activityValid === false) holdReasons.push('root-activity-invalid')
  else if (terminalRootActivity === undefined) holdReasons.push('terminal-root-history-incomplete')
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
    disposition: holdReasons.length === 0 ? 'CANDIDATE' : 'HOLD',
    readyUnclaimed,
    ownerLabel: slot.owner,
    ownerActivity: activity === undefined ? { _tag: 'Unrecorded', source: 'canonical-pool-state-v2' } : {
      _tag: 'Recorded', source: 'canonical-pool-state-v2', authenticatedSeat: false,
      generation: activity.generation, commit: activity.commit, identity: activity.identity, phase: activity.phase,
      event: projectActivityEvent(activity.event),
      claimed: activity.claimed === undefined ? undefined : projectActivityEvent(activity.claimed),
      completed: activity.completed === undefined ? undefined : projectActivityEvent(activity.completed),
    },
    terminalRootActivity,
    claim: {
      state: slot.state,
      tokenPresent: slot.token !== '',
    },
    reservationPresent: slot.reservation !== undefined,
    birth: slot.initialPreparation === undefined ? undefined : {
      generation: slot.initialPreparation.generation, commit: slot.initialPreparation.commit,
    },
    retarget: slot.retarget === undefined ? undefined : { from: slot.retarget.from, to: slot.retarget.to },
    holdReasons,
  }
}

/** No initialization, migration writes, recovery, liveness probes, unlocking or removal. */
export const readPoolProvenance = ({ base }: { base: AbsoluteDirPath }): Effect.Effect<
  ReadonlyArray<PoolRootProvenance>, PoolProvenanceUnavailableError, FileSystem
> => readPoolState({ base }).pipe(
  Effect.map((state) => state.slots.map(projectPoolProvenance)),
  Effect.mapError(() => new PoolProvenanceUnavailableError({
    message: 'Authoritative pool provenance is unavailable',
  })),
)
