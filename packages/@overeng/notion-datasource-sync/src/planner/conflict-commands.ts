import { Schema } from 'effect'

import { bodySurfaceKey, pageSurfaceKey, propertySurfaceKey } from '../core/canonical.ts'
import {
  type CanonicalPropertyValue,
  PatchPagePropertiesCommand,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import { CommandId, PageId, bodyPointerIdentityDigest } from '../core/domain.ts'
import {
  IdempotencyKey,
  SurfaceKey,
  SyncEvent,
  SyncEventId,
  type SyncEvent as SyncEventType,
  type SyncRootId,
} from '../core/events.ts'
import { type GuardName as GuardNameType } from '../core/guards.ts'
import { readUserActionSurface, type PlannedGuard } from '../core/result-envelope.ts'
import { readOneShotSyncStatus } from '../core/status.ts'
import type { AuthorityMode } from '../local/manifest.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import type { ConflictProjectionRow, NotionSyncStore } from '../store/store.ts'
import {
  bodyPushCommandFromLocalChange,
  makeGuardBlockedEvent,
  makeRemoteWritePlannedEvent,
} from '../sync/observation.ts'
import {
  planIntent,
  withAuthorityMode,
  type BodyEditIntent,
  type OutboxCommandEnvelope,
  type PropertyEditIntent,
} from './planner.ts'

/** The user's chosen strategy when resolving a same-property conflict: keep the local value, accept the remote value, or supply a manual replacement. */
export type ConflictResolutionChoice =
  | {
      readonly _tag: 'keep-local'
      readonly value: CanonicalPropertyValue
    }
  | {
      readonly _tag: 'keep-remote'
    }
  | {
      readonly _tag: 'manual'
      readonly value: CanonicalPropertyValue
    }

/** Planned (and separately applied) events, outbox commands, and guard records produced by a user-initiated command before they are written to the store. */
export type PlannedUserAction = {
  readonly events: ReadonlyArray<SyncEventType>
  readonly commands: ReadonlyArray<OutboxCommandEnvelope>
  readonly guards: ReadonlyArray<PlannedGuard>
}

type UserActionOptions = {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dryRun?: boolean
  readonly now?: () => Date
  /**
   * Workspace-wide authority mode (decisions 0015, 0019). Threaded onto the
   * planner snapshot so a `keep-local`/`manual` conflict resolution against a
   * `remote`-authoritative workspace is refused as `RemoteAuthoritativeDrift`
   * rather than silently enqueuing a property patch.
   */
  readonly authorityMode?: AuthorityMode
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const eventIdPart = (value: string): string => value.replaceAll(':', '-').replaceAll('/', '-')

const commandIdFor = (value: string): CommandId =>
  decode({ schema: CommandId, value: `cmd:${eventIdPart(value)}` })

const intentEventIdFor = (value: string): SyncEventId =>
  decode({ schema: SyncEventId, value: `intent:${eventIdPart(value)}` })

const eventPayload = (value: unknown): SyncEventType['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson: JSON.stringify(value),
})

const eventBase = ({
  rootId,
  eventId,
  family,
  eventType,
  idempotencyKey,
  surface,
  causedByEventIds = [],
  payload,
  now,
}: {
  readonly rootId: SyncRootId
  readonly eventId: string
  readonly family: SyncEventType['family']
  readonly eventType: SyncEventType['eventType']
  readonly idempotencyKey: string
  readonly surface?: SurfaceKey
  readonly causedByEventIds?: ReadonlyArray<SyncEventId>
  readonly payload: unknown
  readonly now: () => Date
}) => ({
  eventId,
  rootId,
  sequence: '0',
  codecVersion: 'v1',
  family,
  eventType,
  idempotencyKey,
  surface: surface ?? null,
  causedByEventIds,
  payloadHash: hashStoreBytes('placeholder'),
  payload: eventPayload(payload),
  observedAt: now().toISOString(),
})

const resultEnvelope = <TAction extends string>({
  action,
  rootId,
  store,
  dryRun,
  planned,
  applied,
}: UserActionOptions & {
  readonly action: TAction
  readonly dryRun: boolean
  readonly planned: PlannedUserAction
  readonly applied: PlannedUserAction
}) => ({
  _tag: 'UserCommandResultEnvelope' as const,
  version: 'v1' as const,
  action,
  rootId,
  dryRun,
  status: readOneShotSyncStatus({ store, rootId }),
  surface: readUserActionSurface({ store, rootId }),
  planned,
  applied,
})

const emptyPlan = (): PlannedUserAction => ({ events: [], commands: [], guards: [] })

const guardPlan = ({
  guard,
  surface,
  message,
}: {
  readonly guard: GuardNameType
  readonly surface: string | undefined
  readonly message: string
}): PlannedUserAction => ({
  events: [],
  commands: [],
  guards: [{ guard, surface, message }],
})

const applyPlan = ({
  store,
  rootId,
  dryRun,
  plan,
  now,
}: UserActionOptions & {
  readonly dryRun: boolean
  readonly plan: PlannedUserAction
  readonly now: () => Date
}): PlannedUserAction => {
  if (dryRun === true) return emptyPlan()

  const appliedEvents: SyncEventType[] = []
  const appliedCommands: OutboxCommandEnvelope[] = []
  const appliedGuards: PlannedGuard[] = []

  for (const event of plan.events) {
    const result = store.appendEventWithResult(event)
    if (result.inserted === true) {
      appliedEvents.push(result.event)
    }
  }

  for (const command of plan.commands) {
    const result = store.appendEventWithResult(
      makeRemoteWritePlannedEvent({ command: command, now: now }),
    )
    if (result.inserted === true) {
      appliedCommands.push(command)
    }
  }

  for (const guard of plan.guards) {
    const surface =
      guard.surface ?? pageSurfaceKey(decode({ schema: PageId, value: 'unknown-page' }))
    const result = store.appendEventWithResult(
      makeGuardBlockedEvent({
        rootId,
        guard: guard.guard,
        surface: decode({ schema: SurfaceKey, value: surface }),
        message: guard.message,
        now,
      }),
    )
    if (result.inserted === true) {
      appliedGuards.push(guard)
    }
  }

  return { events: appliedEvents, commands: appliedCommands, guards: appliedGuards }
}

const makeConflictResolvedEvent = ({
  rootId,
  conflict,
  choice,
  followupCommand,
  now,
}: {
  readonly rootId: SyncRootId
  readonly conflict: ConflictProjectionRow
  readonly choice: ConflictResolutionChoice
  readonly followupCommand?: OutboxCommandEnvelope
  readonly now: () => Date
}) =>
  decode({
    schema: SyncEvent,
    value: {
      _tag: 'ConflictResolved',
      ...eventBase({
        rootId,
        eventId: `conflict-resolved:${eventIdPart(conflict.conflictId)}:${choice._tag}`,
        family: 'ConflictResolved',
        eventType: 'ConflictResolved',
        idempotencyKey: `conflict-resolved:${conflict.conflictId}:${choice._tag}`,
        ...(conflict.surface === undefined ? {} : { surface: conflict.surface }),
        causedByEventIds: [conflict.conflictId],
        payload: {
          choice: choice._tag,
          followupCommandId: followupCommand?.commandId,
        },
        now,
      }),
      conflictId: conflict.conflictId,
      pageId: conflict.pageId ?? decode({ schema: PageId, value: 'unknown-page' }),
      propertyId: conflict.propertyId,
      resolutionChoice: choice._tag,
      followupCommandId: followupCommand?.commandId,
    },
  })

const conflictById = ({
  store,
  rootId,
  conflictId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly conflictId: SyncEventId
}): ConflictProjectionRow | undefined =>
  store
    .readConflicts(rootId)
    .find((conflict) => conflict.conflictId === conflictId && conflict.state === 'open')

const resolveValue = (choice: ConflictResolutionChoice): CanonicalPropertyValue | undefined => {
  switch (choice._tag) {
    case 'keep-local':
    case 'manual':
      return choice.value
    case 'keep-remote':
      return undefined
  }
}

/**
 * Resolve an open `lifecycle` conflict (decision 0026). Unlike property conflicts
 * this never enqueues a `PatchPageProperties`:
 *
 * - `keep-remote` (and `manual`): emit `ConflictResolved(keep-remote)`. The store
 *   apply arm reconverges `_nds_row.in_trash` to the recorded `remoteInTrash` and
 *   clears the `remote_trash` tombstone when the remote target is active.
 * - `keep-local`: re-assert the local target `L` (= `!remoteInTrash`) by
 *   re-enqueueing a `TrashPage` (L=1) or `RestorePage` (L=0) push, then emit
 *   `ConflictResolved(keep-local)` with the followup command id. The F8 settle
 *   handler reconverges `in_trash` on settlement. The frozen `_nds_row.in_trash`
 *   already holds L, so this round-trips the user's intent back to the remote.
 */
const resolveLifecycleConflict = ({
  rootId,
  conflict,
  choice,
  now,
}: {
  readonly rootId: SyncRootId
  readonly conflict: ConflictProjectionRow
  readonly choice: ConflictResolutionChoice
  readonly now: () => Date
}): PlannedUserAction => {
  // A lifecycle conflict is raised only when remote `R !== L`, so `L = !R`.
  const remoteInTrash = conflict.remoteInTrash ?? false
  const localTarget = remoteInTrash === false
  const pageId = conflict.pageId ?? decode({ schema: PageId, value: 'unknown-page' })

  if (choice._tag !== 'keep-local') {
    // keep-remote / manual: accept the remote target. The store reconverges
    // `in_trash` from the recorded `remoteInTrash` deterministically on replay.
    return {
      events: [makeConflictResolvedEvent({ rootId, conflict, choice, now })],
      commands: [],
      guards: [],
    }
  }

  // keep-local: re-assert `L` via a fresh lifecycle push. The base hash is the
  // OPPOSITE lifecycle hash (the remote state we are overriding), matching the
  // stale-base contract used by the trash/restore planning paths.
  const basePropertiesHash = pageLifecycleHash({ pageId, inTrash: remoteInTrash })
  const desiredHash = pageLifecycleHash({ pageId, inTrash: localTarget })
  const commandId = commandIdFor(
    `resolve-lifecycle:${conflict.conflictId}:${localTarget === true ? 'trash' : 'restore'}`,
  )
  const commandKey = decode({
    schema: IdempotencyKey,
    value: `resolve-lifecycle:${eventIdPart(conflict.conflictId)}:${localTarget === true ? 'trash' : 'restore'}`,
  })
  const command =
    localTarget === true
      ? decode({
          schema: TrashPageCommand,
          value: { _tag: 'TrashPageCommand', commandId, pageId, basePropertiesHash },
        })
      : decode({
          schema: RestorePageCommand,
          value: { _tag: 'RestorePageCommand', commandId, pageId, basePropertiesHash },
        })
  const followupCommand: OutboxCommandEnvelope = {
    commandId,
    commandKey,
    rootId,
    intentEventId: intentEventIdFor(
      `resolve-lifecycle:${conflict.conflictId}:${localTarget === true ? 'trash' : 'restore'}`,
    ),
    surface: pageSurfaceKey(pageId),
    command,
    baseHash: basePropertiesHash,
    desiredHash,
    preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'DeleteVsEdit'] as const,
  }

  return {
    events: [makeConflictResolvedEvent({ rootId, conflict, choice, followupCommand, now })],
    commands: [followupCommand],
    guards: [],
  }
}

/**
 * Resolve an open `body` conflict (decision 0021). Body is single-surface and
 * adapter-owned: it carries no engine-mergeable value (it is content), so
 * resolution is NOT a value merge but a re-push (local) / re-materialize (remote):
 *
 * - `keep-local`: re-assert the local `.nmd` body by re-enqueueing a
 *   `BodyPushCommand` against the current body pointer (read from the snapshot's
 *   body surface), routed through the planner so the normal body-edit guards
 *   (`StaleSurfaceBase`, `BodyAdapterConflict`, capability) apply. The conflict's
 *   `localHash` is the local body target. On settlement the body pointer
 *   reconverges and the divergence is gone, mirroring the bespoke push path.
 * - `keep-remote` (and `manual`): accept the remote body. Emit
 *   `ConflictResolved(keep-remote)`; the store `body` apply arm retires the
 *   conflict and records the re-materialization intent so the next pull rewrites
 *   the `.nmd` from the remote observation (a DEFERRED remote effect, exactly as
 *   lifecycle keep-remote defers its remote reconvergence).
 */
const resolveBodyConflict = ({
  store,
  rootId,
  conflict,
  choice,
  authorityMode,
  now,
}: UserActionOptions & {
  readonly conflict: ConflictProjectionRow
  readonly choice: ConflictResolutionChoice
  readonly now: () => Date
}): PlannedUserAction => {
  const pageId = conflict.pageId ?? decode({ schema: PageId, value: 'unknown-page' })

  if (choice._tag !== 'keep-local') {
    // keep-remote / manual: accept the remote body. The store `body` apply arm
    // retires the conflict and records the re-materialization intent; the actual
    // `.nmd` rewrite is the next pull's materialization.
    return {
      events: [makeConflictResolvedEvent({ rootId, conflict, choice, now })],
      commands: [],
      guards: [],
    }
  }

  // keep-local: re-push the local `.nmd` body. The base is the current body
  // pointer from the projection; the desired body hash is the conflict's recorded
  // `localHash` (the local body the user is re-asserting).
  const snapshot = withAuthorityMode({
    snapshot: store.readPlannerProjectionSnapshot(rootId),
    authorityMode,
  })
  const bodySurface = snapshot.bodies.find((candidate) => candidate.pageId === pageId)
  if (bodySurface === undefined || conflict.localHash === undefined) {
    return guardPlan({
      guard: 'CurrentSurfaceMissing',
      surface: conflict.surface ?? bodySurfaceKey(pageId),
      message: 'Body conflict resolution requires a current body pointer and a local body hash',
    })
  }

  const baseHash = bodyPointerIdentityDigest(bodySurface.pointer)
  const command = bodyPushCommandFromLocalChange({
    pageId,
    baseBodyPointer: bodySurface.pointer,
    localBodyHash: conflict.localHash,
  })
  const intent: BodyEditIntent = {
    _tag: 'body-edit',
    intentEventId: intentEventIdFor(`resolve-body:${conflict.conflictId}:keep-local`),
    commandKey: decode({
      schema: IdempotencyKey,
      value: `resolve-body:${eventIdPart(conflict.conflictId)}:keep-local`,
    }),
    surface: bodySurfaceKey(pageId),
    pageId,
    command,
    baseHash,
    desiredHash: conflict.localHash,
  }
  const decision = planIntent({ snapshot, intent })

  switch (decision._tag) {
    case 'EnqueueCommands': {
      const followupCommand = decision.commands[0]
      return {
        events:
          followupCommand === undefined
            ? []
            : [makeConflictResolvedEvent({ rootId, conflict, choice, followupCommand, now })],
        commands: decision.commands,
        guards: [],
      }
    }
    case 'BlockedByGuard':
      return {
        events: [],
        commands: [],
        guards: [
          { guard: decision.guard, surface: decision.surface, message: decision.detail.summary },
        ],
      }
    case 'OpenConflict':
      return guardPlan({
        guard: 'StaleSurfaceBase',
        surface: decision.conflict.localSurface,
        message: decision.conflict.message,
      })
    case 'AppendEvents':
      return {
        events: [makeConflictResolvedEvent({ rootId, conflict, choice, now })],
        commands: [],
        guards: [],
      }
  }
}

const conflictResolutionPlan = ({
  store,
  rootId,
  conflictId,
  choice,
  authorityMode,
  now,
}: UserActionOptions & {
  readonly conflictId: SyncEventId
  readonly choice: ConflictResolutionChoice
  readonly now: () => Date
}): PlannedUserAction => {
  const conflict = conflictById({ store, rootId, conflictId })
  if (conflict === undefined) {
    return guardPlan({
      guard: 'CurrentSurfaceMissing',
      surface: undefined,
      message: `Open conflict is missing: ${conflictId}`,
    })
  }

  // Lifecycle conflicts (decision 0026) have a `pageId` but no `propertyId`, and
  // do NOT mirror the property resolution path (no PatchPageProperties). Route
  // them to their own resolver before the property-only refuse block below.
  if (conflict.kind === 'lifecycle' && conflict.pageId !== undefined) {
    return resolveLifecycleConflict({ rootId, conflict, choice, now })
  }

  // Body conflicts (decision 0021) are page-keyed with a null `propertyId` and are
  // adapter-owned: resolution is re-push (keep-local) / re-materialize
  // (keep-remote), NOT a property value merge. Route them to their own resolver
  // before the property-only refuse block below.
  if (conflict.kind === 'body' && conflict.pageId !== undefined) {
    return resolveBodyConflict({
      store,
      rootId,
      conflict,
      choice,
      now,
      ...(authorityMode === undefined ? {} : { authorityMode }),
    })
  }

  if (conflict.pageId === undefined || conflict.propertyId === undefined) {
    return guardPlan({
      guard: 'CurrentSurfaceMissing',
      surface: conflict.surface,
      message: 'Only same-property conflicts can be resolved through this command surface',
    })
  }

  const value = resolveValue(choice)
  if (value === undefined) {
    return {
      events: [makeConflictResolvedEvent({ rootId, conflict, choice, now })],
      commands: [],
      guards: [],
    }
  }

  const snapshot = withAuthorityMode({
    snapshot: store.readPlannerProjectionSnapshot(rootId),
    authorityMode,
  })
  const row = snapshot.rows.find((candidate) => candidate.pageId === conflict.pageId)
  const schemaProperty = snapshot.schema.find(
    (candidate) =>
      row !== undefined &&
      candidate.dataSourceId === row.dataSourceId &&
      candidate.propertyId === conflict.propertyId,
  )
  const conflictRemoteHash = conflict.remoteHash ?? hashStoreBytes('missing-conflict-remote')
  const commandStamp = now().toISOString()
  const commandId = commandIdFor(`resolve:${conflictId}:${choice._tag}:${commandStamp}`)
  const command = decode({
    schema: PatchPagePropertiesCommand,
    value: {
      _tag: 'PatchPagePropertiesCommand',
      commandId,
      pageId: conflict.pageId,
      basePropertiesHash:
        row?.propertiesHash ?? conflict.remoteHash ?? hashStoreBytes('missing-row'),
      propertyPatch: {
        [conflict.propertyId]: value,
      },
    },
  })
  const intent: PropertyEditIntent = {
    _tag: 'property-edit',
    intentEventId: intentEventIdFor(`resolve:${conflictId}:${choice._tag}`),
    commandKey: decode({
      schema: IdempotencyKey,
      value: `resolve:${conflictId}:${choice._tag}:${eventIdPart(commandStamp)}`,
    }),
    surface: propertySurfaceKey({ pageId: conflict.pageId, propertyId: conflict.propertyId }),
    pageId: conflict.pageId,
    propertyId: conflict.propertyId,
    command,
    baseHash: conflictRemoteHash,
    desiredHash: hashStoreBytes(
      `page-properties\t${conflict.pageId}\t${commandId}\t${conflict.propertyId}`,
    ),
    expectedPropertyConfigHash: schemaProperty?.configHash ?? hashStoreBytes('missing-schema'),
  }
  const decision = planIntent({ snapshot: snapshot, intent: intent })

  switch (decision._tag) {
    case 'EnqueueCommands': {
      const followupCommand = decision.commands[0]
      return {
        events:
          followupCommand === undefined
            ? []
            : [makeConflictResolvedEvent({ rootId, conflict, choice, followupCommand, now })],
        commands: decision.commands,
        guards: [],
      }
    }
    case 'BlockedByGuard':
      return {
        events: [],
        commands: [],
        guards: [
          {
            guard: decision.guard,
            surface: decision.surface,
            message: decision.detail.summary,
          },
        ],
      }
    case 'OpenConflict':
      return guardPlan({
        guard: 'StaleSurfaceBase',
        surface: decision.conflict.localSurface,
        message: decision.conflict.message,
      })
    case 'AppendEvents':
      return {
        events: [makeConflictResolvedEvent({ rootId, conflict, choice, now })],
        commands: [],
        guards: [],
      }
  }
}

/** Apply a `ConflictResolutionChoice` to an open same-property conflict, emitting a `ConflictResolved` event and (for keep-local/manual) a follow-up `PatchPageProperties` command. Returns a `UserCommandResultEnvelope`; respects `dryRun`. */
export const resolveConflictCommand = <const TChoice extends ConflictResolutionChoice>(
  options: UserActionOptions & {
    readonly conflictId: SyncEventId
    readonly choice: TChoice
  },
) => {
  const now = options.now ?? (() => new Date())
  const dryRun = options.dryRun === true
  const planned = conflictResolutionPlan({ ...options, now })
  const applied = applyPlan({ ...options, dryRun, plan: planned, now })

  return resultEnvelope({
    ...options,
    action: `resolve-conflict:${options.choice._tag}` as const,
    dryRun,
    planned,
    applied,
  })
}

/** Enqueue a `RestorePageCommand` for a page that is in remote trash or classified as `remote-trash`; blocked if the page cannot be unambiguously restored. Respects `dryRun`. */
export const restorePageCommand = (
  options: UserActionOptions & {
    readonly pageId: PageId
  },
) => {
  const now = options.now ?? (() => new Date())
  const dryRun = options.dryRun === true
  const snapshot = options.store.readPlannerProjectionSnapshot(options.rootId)
  const row = snapshot.rows.find((candidate) => candidate.pageId === options.pageId)
  const tombstone = snapshot.tombstones.find((candidate) => candidate.pageId === options.pageId)
  const canRestore = row?.inTrash === true || tombstone?.state === 'remote-trash'

  const planned: PlannedUserAction =
    canRestore === false
      ? guardPlan({
          guard: tombstone?.state === 'moved-out' ? 'MoveOutNotDelete' : 'QueryAbsenceUnclassified',
          surface: pageSurfaceKey(options.pageId),
          message: 'Restore requires a classified remote trash or current in-trash row state',
        })
      : row === undefined
        ? guardPlan({
            guard: 'CurrentSurfaceMissing',
            surface: pageSurfaceKey(options.pageId),
            message: 'Restore requires a current row projection for stale-base verification',
          })
        : (() => {
            const commandId = commandIdFor(`restore:${options.pageId}:${row.propertiesHash}`)

            return {
              events: [],
              commands: [
                {
                  commandId,
                  commandKey: decode({
                    schema: IdempotencyKey,
                    value: `restore:${options.pageId}:${eventIdPart(row.propertiesHash)}`,
                  }),
                  rootId: options.rootId,
                  intentEventId: intentEventIdFor(`restore:${options.pageId}`),
                  surface: pageSurfaceKey(options.pageId),
                  command: decode({
                    schema: RestorePageCommand,
                    value: {
                      _tag: 'RestorePageCommand',
                      commandId,
                      pageId: options.pageId,
                      basePropertiesHash: row.propertiesHash,
                    },
                  }),
                  baseHash: row.propertiesHash,
                  desiredHash: pageLifecycleHash({ pageId: options.pageId, inTrash: false }),
                  preflight: [
                    'CapabilityPreflightFailed',
                    'StaleSurfaceBase',
                    'DeleteVsEdit',
                  ] as const,
                },
              ],
              guards: [],
            }
          })()
  const applied = applyPlan({ ...options, dryRun, plan: planned, now })

  return resultEnvelope({
    ...options,
    action: 'restore-page',
    dryRun,
    planned,
    applied,
  })
}
