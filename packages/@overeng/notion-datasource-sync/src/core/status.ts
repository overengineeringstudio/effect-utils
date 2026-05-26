import type { NotionSyncStore, StoreStatusProjection } from '../store/store.ts'
import type { AbsolutePath, DataSourceId } from './domain.ts'
import type { SyncRootId } from './events.ts'

/** Aggregated health state of a sync root for a single command run; priority order: `conflict` > `blocked` > `pending` > `clean`. */
export type OneShotStatusState = 'clean' | 'pending' | 'conflict' | 'blocked'

/** Full status snapshot for a sync root: binding info, aggregated `state`, and detailed projection counts used to derive that state. */
export type OneShotSyncStatus = {
  readonly rootId: SyncRootId
  readonly binding:
    | {
        readonly dataSourceId: DataSourceId
        readonly workspaceRoot: AbsolutePath
        readonly storeIdentity: string
      }
    | undefined
  readonly state: OneShotStatusState
  readonly counts: {
    readonly clean: number
    readonly pending: number
    readonly conflict: number
    readonly blocked: number
    readonly outbox: StoreStatusProjection['outbox']
    readonly projections: StoreStatusProjection['projections']
    readonly tombstones: StoreStatusProjection['tombstones']
    readonly guards: StoreStatusProjection['guards']
    readonly capabilities: StoreStatusProjection['capabilities']
    readonly checkpoints: StoreStatusProjection['checkpoints']
  }
}

const latestBinding = ({
  store,
  rootId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
}): OneShotSyncStatus['binding'] => {
  let binding: ReturnType<NotionSyncStore['replay']>[number] | undefined
  for (const event of store.replay(rootId)) {
    if (event._tag === 'SyncBindingRecorded') {
      binding = event
    }
  }

  return binding?._tag === 'SyncBindingRecorded'
    ? {
        dataSourceId: binding.dataSourceId,
        workspaceRoot: binding.workspaceRoot,
        storeIdentity: binding.storeIdentity,
      }
    : undefined
}

/** Computes the `OneShotSyncStatus` for a sync root by reading projections from the store and applying the conflict > blocked > pending > clean priority rule. */
export const readOneShotSyncStatus = ({
  store,
  rootId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
}): OneShotSyncStatus => {
  const projection = store.readStatusProjection(rootId)
  const pending = projection.outbox.queued + projection.outbox.running + projection.outbox.retryable
  const conflict = projection.conflicts.open
  const blocked =
    projection.outbox.blocked +
    projection.outbox.fenced +
    projection.outbox.ambiguous +
    projection.tombstones.unclassified +
    projection.guards.blocked +
    projection.capabilities.unsupported +
    projection.checkpoints.incompleteQueries +
    projection.checkpoints.cappedQueries +
    projection.checkpoints.changedQueryContracts +
    projection.checkpoints.incompleteProperties
  const state: OneShotStatusState =
    conflict > 0 ? 'conflict' : blocked > 0 ? 'blocked' : pending > 0 ? 'pending' : 'clean'

  return {
    rootId,
    binding: latestBinding({ store, rootId }),
    state,
    counts: {
      clean: state === 'clean' ? 1 : 0,
      pending,
      conflict,
      blocked,
      outbox: projection.outbox,
      projections: projection.projections,
      tombstones: projection.tombstones,
      guards: projection.guards,
      capabilities: projection.capabilities,
      checkpoints: projection.checkpoints,
    },
  }
}
