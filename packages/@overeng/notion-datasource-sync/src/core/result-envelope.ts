import type { OutboxCommandEnvelope } from '../planner/planner.ts'
import type {
  ConflictProjectionRow,
  GuardBlockProjectionRow,
  NotionSyncStore,
  OutboxProjectionRow,
  TombstoneProjectionRow,
} from '../store/store.ts'
import type { SyncEvent, SyncRootId } from './events.ts'
import type { GuardName } from './guards.ts'
import type { OneShotSyncStatus } from './status.ts'

/** Snapshot of user-facing sync state: open conflicts, guard blocks, tombstones, and non-settled outbox commands. */
export type UserActionSurface = {
  readonly conflicts: ReadonlyArray<ConflictProjectionRow>
  readonly guards: ReadonlyArray<GuardBlockProjectionRow>
  readonly tombstones: ReadonlyArray<TombstoneProjectionRow>
  readonly outbox: ReadonlyArray<OutboxProjectionRow>
}

/** A guard decision that was evaluated during command planning; surfaced in the result envelope for diagnostics. */
export type PlannedGuard = {
  readonly guard: typeof GuardName.Type
  readonly surface: string | undefined
  readonly message: string
}

/** The set of events, outbox commands, and guard decisions that were produced during a single user command execution. */
export type UserCommandPlan = {
  readonly events: ReadonlyArray<SyncEvent>
  readonly commands: ReadonlyArray<OutboxCommandEnvelope>
  readonly guards: ReadonlyArray<PlannedGuard>
}

/**
 * Versioned result envelope returned to the caller after any user-facing sync command.
 *
 * `planned` reflects what the planner decided; `applied` reflects what was actually persisted (empty in dry-run mode).
 * The `status` field gives the aggregated sync health at the end of the command.
 */
export type UserCommandResultEnvelope<TAction extends string = string> = {
  readonly _tag: 'UserCommandResultEnvelope'
  readonly version: 'v1'
  readonly action: TAction
  readonly rootId: SyncRootId
  readonly dryRun: boolean
  readonly status: OneShotSyncStatus
  readonly surface: UserActionSurface
  readonly planned: UserCommandPlan
  readonly applied: UserCommandPlan
}

/** Reads the current `UserActionSurface` from the store for a given sync root, filtering out settled outbox commands and closed conflicts. */
export const readUserActionSurface = ({
  store,
  rootId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
}): UserActionSurface => ({
  conflicts: store.readConflicts(rootId).filter((conflict) => conflict.state === 'open'),
  guards: store.readGuardBlocks(rootId),
  tombstones: store.readTombstones(rootId),
  outbox: store.readOutbox(rootId).filter((command) => command.state !== 'settled'),
})
