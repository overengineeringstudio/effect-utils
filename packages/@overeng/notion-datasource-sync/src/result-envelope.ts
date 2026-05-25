import type { SyncEvent, SyncRootId } from './events.ts'
import type { GuardName } from './guards.ts'
import type { OutboxCommandEnvelope } from './planner.ts'
import type { OneShotSyncStatus } from './status.ts'
import type {
  ConflictProjectionRow,
  GuardBlockProjectionRow,
  NotionSyncStore,
  OutboxProjectionRow,
  TombstoneProjectionRow,
} from './store.ts'

export type UserActionSurface = {
  readonly conflicts: ReadonlyArray<ConflictProjectionRow>
  readonly guards: ReadonlyArray<GuardBlockProjectionRow>
  readonly tombstones: ReadonlyArray<TombstoneProjectionRow>
  readonly outbox: ReadonlyArray<OutboxProjectionRow>
}

export type PlannedGuard = {
  readonly guard: typeof GuardName.Type
  readonly surface: string | undefined
  readonly message: string
}

export type UserCommandPlan = {
  readonly events: ReadonlyArray<SyncEvent>
  readonly commands: ReadonlyArray<OutboxCommandEnvelope>
  readonly guards: ReadonlyArray<PlannedGuard>
}

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
