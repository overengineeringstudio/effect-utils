import { Effect, Schema } from 'effect'

import {
  bodySurfaceKey,
  pageSurfaceKey,
  queryContractHash as computeQueryContractHash,
  querySurfaceKey,
} from '../core/canonical.ts'
import {
  Hash,
  bodyPointerIdentityDigest,
  renderedBodyDigest,
  type LocalArtifactObservation,
  PageId,
  PropertyId,
  type AbsolutePath,
  type PageSnapshot,
} from '../core/domain.ts'
import type { BodySyncError, LocalStorageError, LocalStoreError } from '../core/errors.ts'
import {
  NotionGatewayError,
  type NotionGatewayError as NotionGatewayErrorType,
} from '../core/errors.ts'
import type { SyncEvent as SyncEventType } from '../core/events.ts'
import {
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePort,
} from '../core/ports.ts'
import { reportSyncProgress } from '../core/progress.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from '../core/status.ts'
import type { AuthorityMode } from '../local/manifest.ts'
import {
  annotateSpan,
  shortSpanId,
  spanAttr,
  spanLabel,
  spanNames,
  statusSpanAttributes,
} from '../observability/observability.ts'
import {
  applyConvergenceVerdicts,
  type PropertyConvergenceVerdict,
} from '../planner/local-convergence.ts'
import {
  planIntent,
  withAuthorityMode,
  type BodyEditIntent,
  type LocalDeleteIntent,
  type PlanDecision,
  type PlannerIntent,
  type PlannerProjectionSnapshot,
} from '../planner/planner.ts'
import { pageLifecycleHash } from '../store/projections.ts'
import type { NotionSyncStore } from '../store/store.ts'
import { executeOutboxOnce, type OutboxExecutionResult } from './executor.ts'
import {
  bodyPushCommandFromLocalChange,
  commandIdFor,
  commandKeyFor,
  intentEventIdFor,
  makeConflictRaisedEvent,
  makeGuardBlockedEvent,
  makePlannerEvent,
  makeQueryAbsenceCandidateEvent,
  makeRemoteWritePlannedEvent,
  makeSyncBindingRecordedEvent,
  observeLocalWorkspace,
  observeRemoteDataSource,
  type LocalWorkspaceObservationResult,
  type RemoteObservationOptions,
  type RemoteObservationResult,
} from './observation.ts'

/** Options for `initOneShotSync`, which records the initial `SyncBindingRecorded` event tying a data source to a local workspace root. */
export type OneShotInitOptions = {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly dataSourceId: RemoteObservationOptions['dataSourceId']
  readonly workspaceRoot: AbsolutePath
  readonly storeIdentity?: string
  readonly now?: () => Date
  readonly dryRun?: boolean
}

/** Options for `pullOneShotSync`; extends `RemoteObservationOptions` with store access and a `dryRun` flag. */
export type OneShotPullOptions = {
  readonly store: NotionSyncStore
  readonly dryRun?: boolean
} & RemoteObservationOptions

/** Options for `pushOneShotSync`; controls the local workspace root, pre-built intents, executor step limit, and outbox lease settings. */
export type OneShotPushOptions = {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly workspaceRoot: AbsolutePath
  readonly localWorkspaceObservation?: LocalWorkspaceObservationResult
  readonly localIntents?: ReadonlyArray<PlannerIntent>
  readonly materializeBodies?: boolean
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
  readonly dryRun?: boolean
  /**
   * Workspace-wide authority mode (decisions 0015, 0019), threaded onto every
   * planner property snapshot's `writeMode`. `remote` makes local property edits
   * drift (`RemoteAuthoritativeDrift`); `local`/`shared` reach the property-write
   * proof. Absent leaves the planner's `shared` default.
   */
  readonly authorityMode?: AuthorityMode
  /**
   * SM5c local-convergence property verdicts, overlaid onto every planner
   * property snapshot's `localConvergence` before planning. A `disagrees` verdict
   * makes the shared PropertyWriteCore block the write as `LocalSurfaceDisagreement`
   * (the SQLite `pages` edit and the page's `.nmd` frontmatter diverge). Empty /
   * absent leaves the planner's `not-applicable` default. Only meaningful in
   * `shared` mode; the caller computes it via `convergeLocalSurfaces`.
   */
  readonly convergenceVerdicts?: ReadonlyArray<PropertyConvergenceVerdict>
}

/** Combined options for `syncOneShot`, merging pull and push settings into a single pass. */
export type OneShotSyncOptions = OneShotPullOptions &
  Pick<
    OneShotPushOptions,
    | 'localIntents'
    | 'materializeBodies'
    | 'maxExecutorSteps'
    | 'leaseToken'
    | 'leaseDurationMs'
    | 'authorityMode'
  > & {
    readonly deferLocalPlanningUntilAfterPull?: boolean
    /**
     * Mirror (`remote`-authority) reconcile: run ONLY the remote→local pull pass
     * and skip BOTH internal local→remote push passes, so no local intent reaches
     * the executor or the gateway (SM5.4 / CLI-R07). The watch daemon sets this for
     * a `remote`-mode workspace; one-shot `sync` never does, so the default
     * push+pull behavior is preserved. This is the loop-level complement to the
     * planner's per-write `RemoteAuthoritativeDrift` block — it keeps the daemon's
     * promise to "follow remote" structurally, instead of relying on every staged
     * intent being individually refused.
     */
    readonly pullOnly?: boolean
  }

/** Options for first establishment from an existing Notion data source into a local workspace. */
export type EstablishFromNotionOptions = OneShotPullOptions & OneShotInitOptions

/** Aggregate counts produced by the planning phase of a push: how many decisions were made and how many events, commands, blocks, and conflicts resulted. */
export type OneShotPlanSummary = {
  readonly decisions: ReadonlyArray<PlanDecision>
  readonly appendedEvents: number
  readonly enqueuedCommands: number
  readonly blocked: number
  readonly conflicts: number
}

/** Result of a single push pass: local observation count, planning summary, outbox executor run, and current sync status. */
export type OneShotPushResult = {
  readonly localObservations: number
  readonly plan: OneShotPlanSummary
  readonly executor: {
    readonly steps: number
    readonly maxStepsReached: boolean
    readonly results: ReadonlyArray<OutboxExecutionResult>
  }
  readonly status: OneShotSyncStatus
}

/** Result of a single pull pass: raw remote observation, count of events appended to the store, and current sync status. */
export type OneShotPullResult = {
  readonly observation: RemoteObservationResult
  readonly appendedEvents: number
  readonly status: OneShotSyncStatus
}

/** Combined result of a full pull-then-push sync pass. */
export type OneShotSyncResult = {
  readonly pull: OneShotPullResult
  readonly push: OneShotPushResult
  readonly status: OneShotSyncStatus
}

/** Result of first establishment: remote validation, binding status, pull result, and explicit push suppression. */
export type EstablishFromNotionResult = {
  readonly mode: 'establish-from-notion'
  readonly remoteValidated: boolean
  readonly binding: OneShotSyncStatus
  readonly pull: OneShotPullResult
  readonly pushed: false
  readonly status: OneShotSyncStatus
}

const decode = <TSchema extends Schema.Codec<any, any, never>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const fallbackHash = (_value: string) => decode({ schema: Hash, value: `sha256:${'0'.repeat(64)}` })

const pageIdFromSurface = (surface: string): PageId => {
  const match = /^page:([^:]+)/.exec(surface)
  return decode({ schema: PageId, value: match?.[1] ?? 'unknown-page' })
}

const propertyIdFromSurface = (surface: string): PropertyId | undefined => {
  const match = /^page:[^:]+:property:(.+)$/.exec(surface)
  return match?.[1] === undefined ? undefined : decode({ schema: PropertyId, value: match[1] })
}

const appendDecision = ({
  store,
  rootId,
  decision,
  pageId,
  now,
  dryRun,
}: {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly decision: PlanDecision
  readonly pageId?: PageId
  readonly now: () => Date
  readonly dryRun?: boolean
}): OneShotPlanSummary => {
  switch (decision._tag) {
    case 'AppendEvents': {
      let appendedEvents = 0
      for (const plannerEvent of decision.events) {
        const event = makePlannerEvent({ rootId, event: plannerEvent, now })
        if (event === undefined) continue
        if (dryRun === true) continue
        if (store.appendEventWithResult(event).inserted === true) {
          appendedEvents += 1
        }
      }
      return {
        decisions: [decision],
        appendedEvents,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 0,
      }
    }
    case 'EnqueueCommands': {
      let enqueuedCommands = 0
      for (const command of decision.commands) {
        if (dryRun === true) continue
        if (
          store.appendEventWithResult(makeRemoteWritePlannedEvent({ command, now })).inserted ===
          true
        ) {
          enqueuedCommands += 1
        }
      }
      return {
        decisions: [decision],
        appendedEvents: 0,
        enqueuedCommands,
        blocked: 0,
        conflicts: 0,
      }
    }
    case 'OpenConflict': {
      const surface = decision.conflict.localSurface
      const propertyId = propertyIdFromSurface(surface)
      if (dryRun === true) {
        return {
          decisions: [decision],
          appendedEvents: 0,
          enqueuedCommands: 0,
          blocked: 0,
          conflicts: 0,
        }
      }
      const inserted = store.appendEventWithResult(
        makeConflictRaisedEvent({
          rootId,
          pageId: pageId ?? pageIdFromSurface(surface),
          ...(propertyId === undefined ? {} : { propertyId }),
          surface,
          baseHash: decision.conflict.baseHash ?? fallbackHash('missing-base'),
          localHash: decision.conflict.localHash ?? fallbackHash('missing-local'),
          remoteHash: decision.conflict.remoteHash ?? fallbackHash('missing-remote'),
          ...(propertyId === undefined ? {} : { conflictKind: 'property' }),
          message: decision.conflict.message,
          now,
        }),
      ).inserted
      return {
        decisions: [decision],
        appendedEvents: inserted === true ? 1 : 0,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: inserted === true ? 1 : 0,
      }
    }
    case 'BlockedByGuard': {
      if (dryRun === true) {
        return {
          decisions: [decision],
          appendedEvents: 0,
          enqueuedCommands: 0,
          blocked: 0,
          conflicts: 0,
        }
      }
      const inserted = store.appendEventWithResult(
        makeGuardBlockedEvent({
          rootId,
          guard: decision.guard,
          surface: decision.surface,
          message: decision.detail.summary,
          evidence: decision.detail.evidence,
          now,
        }),
      ).inserted
      return {
        decisions: [decision],
        appendedEvents: inserted === true ? 1 : 0,
        enqueuedCommands: 0,
        blocked: inserted === true ? 1 : 0,
        conflicts: 0,
      }
    }
  }
}

/**
 * Empty push result for a mirror (`remote`-authority) reconcile that ran no push
 * pass; carries the current status so the `OneShotSyncResult` plan frame stays
 * well-formed. Call it AFTER the pull pass so `status` reflects the appended
 * pull events (the top-level `syncOneShot` `status` is the authoritative result
 * field; this `push.status` is a convenience mirror of the same post-pull read).
 */
const emptyPushResult = ({
  store,
  rootId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
}): OneShotPushResult => ({
  localObservations: 0,
  plan: { decisions: [], appendedEvents: 0, enqueuedCommands: 0, blocked: 0, conflicts: 0 },
  executor: { steps: 0, maxStepsReached: false, results: [] },
  status: readOneShotSyncStatus({ store, rootId }),
})

const mergePlanSummaries = (summaries: ReadonlyArray<OneShotPlanSummary>): OneShotPlanSummary => ({
  decisions: summaries.flatMap((summary) => summary.decisions),
  appendedEvents: summaries.reduce((sum, summary) => sum + summary.appendedEvents, 0),
  enqueuedCommands: summaries.reduce((sum, summary) => sum + summary.enqueuedCommands, 0),
  blocked: summaries.reduce((sum, summary) => sum + summary.blocked, 0),
  conflicts: summaries.reduce((sum, summary) => sum + summary.conflicts, 0),
})

const localDeleteIntentFromObservation = (observation: {
  readonly pageId: PageId
  readonly contentHash: Hash
}): LocalDeleteIntent => ({
  _tag: 'local-delete',
  intentEventId: intentEventIdFor(`delete:${observation.pageId}`),
  commandKey: commandKeyFor(`delete:${observation.pageId}`),
  surface: pageSurfaceKey(observation.pageId),
  pageId: observation.pageId,
  command: {
    _tag: 'TrashPageCommand',
    commandId: commandIdFor(`delete:${observation.pageId}`),
    pageId: observation.pageId,
    basePropertiesHash: observation.contentHash,
  },
  baseHash: observation.contentHash,
  desiredHash: pageLifecycleHash({ pageId: observation.pageId, inTrash: true }),
  explicitDestructiveIntent: false,
  policy: 'candidateOnly',
  directRetrieve: 'accessible',
})

const canClassifyDisappearedRows = (options: OneShotPullOptions): boolean =>
  options.queryContract.membershipScope === 'all-data-source-rows' &&
  options.queryContract.filter === null &&
  options.queryContract.highWatermark === null

type QueryAbsenceDirectRetrieve =
  | 'accessible'
  | 'in-trash'
  | 'moved-out'
  | 'permission-ambiguous'
  | 'inaccessible'
  | 'unknown'

const classifyQueryAbsencePage = ({
  dataSourceId,
  page,
}: {
  readonly dataSourceId: OneShotPullOptions['dataSourceId']
  readonly page: PageSnapshot
}): QueryAbsenceDirectRetrieve => {
  if (page.inTrash === true) return 'in-trash'
  if (page.dataSourceId !== dataSourceId) return 'moved-out'
  return 'accessible'
}

const classifyQueryAbsenceError = (error: NotionGatewayErrorType): QueryAbsenceDirectRetrieve =>
  error instanceof NotionGatewayError && error.guard === 'PermissionAmbiguous'
    ? 'permission-ambiguous'
    : 'unknown'

const queryAbsenceRecordedReason = (
  directRetrieve: QueryAbsenceDirectRetrieve,
): 'remote-trash' | 'moved-out' | 'inaccessible' | 'unknown' | undefined => {
  switch (directRetrieve) {
    case 'accessible':
    case 'permission-ambiguous':
      return undefined
    case 'in-trash':
      return 'remote-trash'
    case 'moved-out':
      return 'moved-out'
    case 'inaccessible':
      return 'inaccessible'
    case 'unknown':
      return 'unknown'
  }
}

const annotateOneShotStart = (input: {
  readonly operation: 'pull' | 'push' | 'sync' | 'establish-from-notion'
  readonly rootId: RemoteObservationOptions['rootId']
  readonly dataSourceId?: RemoteObservationOptions['dataSourceId']
  readonly dryRun?: boolean
  readonly maxExecutorSteps?: number
  readonly leaseDurationMs?: number
}) =>
  annotateSpan({
    [spanAttr.spanLabel]: spanLabel(input.operation, shortSpanId(input.rootId)),
    [spanAttr.processRole]: 'library',
    [spanAttr.operation]: input.operation,
    [spanAttr.rootId]: input.rootId,
    [spanAttr.dataSourceId]: input.dataSourceId,
    [spanAttr.dryRun]: input.dryRun === true,
    [spanAttr.maxExecutorSteps]: input.maxExecutorSteps,
    [spanAttr.leaseDurationMs]: input.leaseDurationMs,
  })

const resumeCursorForPull = (options: OneShotPullOptions) => {
  const expectedQueryContractHash = computeQueryContractHash({
    input: {
      _tag: 'QueryRowsInput',
      dataSourceId: options.dataSourceId,
      queryContract: options.queryContract,
      startCursor: null,
    },
    apiVersion: options.queryContract.apiVersion,
  })
  const checkpoint = options.store.readQueryCheckpoint({
    rootId: options.rootId,
    dataSourceId: options.dataSourceId,
    queryContractHash: expectedQueryContractHash,
  })

  return checkpoint?.complete === false ? checkpoint.nextCursor : null
}

const disappearanceCandidateEvents = Effect.fn(spanNames.syncQueryAbsence)(
  ({
    options,
    observation,
  }: {
    readonly options: OneShotPullOptions
    readonly observation: RemoteObservationResult
  }) =>
    Effect.gen(function* () {
      yield* annotateSpan({
        [spanAttr.spanLabel]: spanLabel('query-absence', shortSpanId(options.rootId)),
        [spanAttr.rootId]: options.rootId,
        [spanAttr.dataSourceId]: options.dataSourceId,
      })
      if (
        observation.query.startCursor !== null ||
        observation.query.complete === false ||
        observation.query.cappedAtLimit === true ||
        observation.query.queryContractHash === undefined ||
        canClassifyDisappearedRows(options) === false
      ) {
        return []
      }

      const observedPageIds = new Set(
        observation.events
          .filter((event) => event._tag === 'RowObserved')
          .map((event) => event.pageId),
      )
      const queryContractHash = observation.query.queryContractHash
      if (queryContractHash === undefined) return []

      const gateway = yield* NotionDataSourceGateway
      const events = []
      for (const row of options.store
        .readPlannerProjectionSnapshot(options.rootId)
        .rows.filter((candidate) => candidate.dataSourceId === options.dataSourceId)
        .filter((candidate) => observedPageIds.has(candidate.pageId) === false)) {
        const directRetrieve = yield* gateway.retrievePage(row.pageId).pipe(
          Effect.match({
            onFailure: classifyQueryAbsenceError,
            onSuccess: (page) =>
              classifyQueryAbsencePage({ dataSourceId: options.dataSourceId, page }),
          }),
        )
        const candidate = makeQueryAbsenceCandidateEvent({
          rootId: options.rootId,
          dataSourceId: options.dataSourceId,
          pageId: row.pageId,
          queryContractHash,
          queryContract: options.queryContract,
          directRetrieve,
          ...(options.now === undefined ? {} : { now: options.now }),
        })
        events.push(candidate)

        const reason = queryAbsenceRecordedReason(directRetrieve)
        if (reason !== undefined) {
          const recorded = makePlannerEvent({
            rootId: options.rootId,
            event: {
              _tag: 'TombstoneClassified',
              pageId: row.pageId,
              surface:
                candidate.surface ??
                querySurfaceKey({ dataSourceId: options.dataSourceId, queryContractHash }),
              reason,
            },
            ...(options.now === undefined ? {} : { now: options.now }),
          })
          if (recorded !== undefined) events.push(recorded)
        }
      }

      return events
    }),
)

/** Record the initial `SyncBindingRecorded` event that ties a data source to its local workspace root; idempotent and synchronous. */
export const initOneShotSync = (options: OneShotInitOptions): OneShotSyncStatus => {
  if (options.dryRun !== true) {
    options.store.appendEvent(
      makeSyncBindingRecordedEvent({
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        workspaceRoot: options.workspaceRoot,
        storeIdentity: options.storeIdentity ?? `store:${options.rootId}`,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    )
  }

  return readOneShotSyncStatus({ store: options.store, rootId: options.rootId })
}

const hasLocalWorkspaceChange = ({
  observations,
  store,
  rootId,
}: {
  readonly observations: ReadonlyArray<LocalArtifactObservation>
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
}) => {
  const snapshot = store.readPlannerProjectionSnapshot(rootId)
  return observations.some((observation) => {
    if (observation.state === 'delete-candidate') return true
    const bodySurface = snapshot.bodies.find((candidate) => candidate.pageId === observation.pageId)
    return bodySurface !== undefined && bodySurface.currentHash !== observation.contentHash
  })
}

/**
 * Lifecycle-divergence detection for a single observation event (decision 0026).
 *
 * For a `RowObserved` with remote trash state `R`, compares against the SETTLED
 * local lifecycle target `L` (from `store.readSettledLifecycleTarget`, which reads
 * the settled `TrashPage`/`RestorePage` outbox history — NOT `_nds_row.in_trash`,
 * whose overloaded writes would manufacture false positives). Returns the events
 * to append BEFORE the `RowObserved` when they diverge:
 *
 * - `L === undefined` (no settled lifecycle intent) → no conflict; benign remote
 *   trash state applies normally. This covers the initial state and benign remote
 *   toggles — the false-positive guard.
 * - `R === L` → benign; the RowObserved applies normally.
 * - `R !== L` → a lifecycle CONFLICT: emit a `ConflictRaised(lifecycle)` carrying
 *   `remoteInTrash: R`, plus a `PendingIntentShadowViolation` `GuardBlocked`
 *   diagnostic ("a remote observation would overwrite a settled local target").
 *
 * Non-`RowObserved` events and the no-divergence cases return an empty array.
 */
const lifecycleDivergenceEvents = ({
  store,
  event,
  now,
}: {
  readonly store: NotionSyncStore
  readonly event: SyncEventType
  readonly now?: () => Date
}): ReadonlyArray<SyncEventType> => {
  if (event._tag !== 'RowObserved') return []

  const localTarget = store.readSettledLifecycleTarget({
    rootId: event.rootId,
    pageId: event.pageId,
  })
  if (localTarget === undefined || localTarget === event.inTrash) return []

  const surface = pageSurfaceKey(event.pageId)
  const localHash = pageLifecycleHash({ pageId: event.pageId, inTrash: localTarget })
  const remoteHash = pageLifecycleHash({ pageId: event.pageId, inTrash: event.inTrash })
  const message = `Remote lifecycle observation (in_trash=${event.inTrash}) would overwrite the settled local target (in_trash=${localTarget})`

  return [
    makeConflictRaisedEvent({
      rootId: event.rootId,
      pageId: event.pageId,
      surface,
      conflictKind: 'lifecycle',
      remoteInTrash: event.inTrash,
      // Lifecycle has no three-way base; the local target hash is a deterministic,
      // replay-stable base sentinel (not part of the idempotency key).
      baseHash: localHash,
      localHash,
      remoteHash,
      message,
      ...(now === undefined ? {} : { now }),
    }),
    makeGuardBlockedEvent({
      rootId: event.rootId,
      guard: 'PendingIntentShadowViolation',
      surface,
      message,
      ...(now === undefined ? {} : { now }),
    }),
  ]
}

/**
 * Symmetric lifecycle-divergence detection for a `TombstoneRecorded(remote_trash)`
 * event (decision 0026, the tombstone direction mirroring `lifecycleDivergenceEvents`).
 *
 * A remote-initiated trash arrives as a tombstone (`R = 1`, in_trash), NOT a
 * `RowObserved` (a trashed page drops out of `data_source.query`). It is compared
 * against the SETTLED local lifecycle target `L` (via `store.readSettledLifecycleTarget`,
 * NOT `_nds_row.in_trash`, whose overloaded writes would manufacture false positives):
 *
 * - `L === undefined` (no settled lifecycle intent) → no conflict; the tombstone
 *   applies normally (in_trash = 1). Covers the initial/benign remote trash — the
 *   false-positive guard.
 * - `L === true` (settled local TRASH; matches `R = 1`) → benign; no conflict.
 * - `L === false` (settled local RESTORE) → divergence from `R = 1`: emit a
 *   `ConflictRaised(lifecycle, remoteInTrash: true)` plus a
 *   `PendingIntentShadowViolation` `GuardBlocked` diagnostic — the remote trash
 *   would otherwise silently override the settled local restore (XC-R02).
 *
 * Non-`TombstoneRecorded`, non-`remote_trash`, and no-divergence cases return `[]`.
 */
const tombstoneLifecycleDivergenceEvents = ({
  store,
  event,
  now,
}: {
  readonly store: NotionSyncStore
  readonly event: SyncEventType
  readonly now?: () => Date
}): ReadonlyArray<SyncEventType> => {
  if (event._tag !== 'TombstoneRecorded' || event.reason !== 'remote_trash') return []

  const localTarget = store.readSettledLifecycleTarget({
    rootId: event.rootId,
    pageId: event.pageId,
  })
  // Remote trash implies R = in_trash = true; benign when no settled intent or L matches R.
  if (localTarget === undefined || localTarget === true) return []

  const surface = pageSurfaceKey(event.pageId)
  const localHash = pageLifecycleHash({ pageId: event.pageId, inTrash: localTarget })
  const remoteHash = pageLifecycleHash({ pageId: event.pageId, inTrash: true })
  const message = `Remote trash (in_trash=true) would overwrite the settled local target (in_trash=${localTarget})`

  return [
    makeConflictRaisedEvent({
      rootId: event.rootId,
      pageId: event.pageId,
      surface,
      conflictKind: 'lifecycle',
      remoteInTrash: true,
      // Lifecycle has no three-way base; the local target hash is a deterministic,
      // replay-stable base sentinel (not part of the idempotency key).
      baseHash: localHash,
      localHash,
      remoteHash,
      message,
      ...(now === undefined ? {} : { now }),
    }),
    makeGuardBlockedEvent({
      rootId: event.rootId,
      guard: 'PendingIntentShadowViolation',
      surface,
      message,
      ...(now === undefined ? {} : { now }),
    }),
  ]
}

/** Observe the remote data source (API, schema, rows, properties, bodies) and persist the resulting events to the local store. Resumes a partial query scan if a checkpoint cursor exists. */
export const pullOneShotSync = Effect.fn(spanNames.syncPull)(
  (
    options: OneShotPullOptions,
  ): Effect.Effect<
    OneShotPullResult,
    NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* annotateOneShotStart({
        operation: 'pull',
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      })
      yield* reportSyncProgress({ _tag: 'phase', phase: 'pulling' })
      // Body keep-remote re-materialization (decision 0021). A body pointer whose
      // `sidecarIdentityProven` was cleared by a keep-remote resolution must be
      // re-materialized from the remote observation even under the mirror path's
      // global `materializeBodyArtifacts: false` suppression — keep-remote accepted
      // the remote body, so the still-diverged local `.nmd` is overwritten.
      const forceMaterializePageIds = new Set(
        options.store
          .readPlannerProjectionSnapshot(options.rootId)
          .bodies.filter((body) => body.sidecarIdentityProven === false)
          .map((body) => body.pageId),
      )
      const observation = yield* observeRemoteDataSource({
        ...options,
        ...(options.dryRun === true ? { materializeBodies: false } : {}),
        ...(forceMaterializePageIds.size === 0 ? {} : { forceMaterializePageIds }),
        startCursor: options.startCursor ?? resumeCursorForPull(options),
      })
      let appendedEvents = 0
      for (const event of observation.events) {
        if (options.dryRun === true) continue
        // Lifecycle-divergence detection (decision 0026). A `RowObserved` whose
        // remote trash state `R` diverges from the SETTLED local lifecycle target
        // `L` is a conflict, not a silent flip (XC-R02). Detect here — the shared
        // ingestion seam for one-shot AND watch (both funnel through
        // `pullOneShotSync`) — and append the `ConflictRaised` (plus the
        // `PendingIntentShadowViolation` diagnostic) BEFORE the `RowObserved`, so
        // the open conflict has a LOWER sequence and is visible when the
        // RowObserved applies during pure full-log replay. Detection is never in
        // the apply path (projections cannot append events).
        for (const lifecycleEvent of lifecycleDivergenceEvents({
          store: options.store,
          event,
          ...(options.now === undefined ? {} : { now: options.now }),
        })) {
          if (options.store.appendEventWithResult(lifecycleEvent).inserted === true) {
            appendedEvents += 1
          }
        }
        if (options.store.appendEventWithResult(event).inserted === true) {
          appendedEvents += 1
        }
      }
      const absenceEvents = yield* disappearanceCandidateEvents({ options, observation })
      for (const event of absenceEvents) {
        if (options.dryRun === true) continue
        // Symmetric lifecycle-divergence detection (decision 0026, tombstone
        // direction). A `TombstoneRecorded(remote_trash)` whose remote trash
        // (`R = 1`) diverges from the SETTLED local restore target (`L = 0`) is a
        // conflict, not a silent flip (XC-R02). Append the `ConflictRaised` (plus
        // the `PendingIntentShadowViolation` diagnostic) BEFORE the tombstone, so
        // the open conflict has a LOWER sequence and freezes the tombstone's
        // `in_trash = 1` write during full-log replay. Mirrors the `RowObserved`
        // restore-after-archive seam above.
        for (const lifecycleEvent of tombstoneLifecycleDivergenceEvents({
          store: options.store,
          event,
          ...(options.now === undefined ? {} : { now: options.now }),
        })) {
          if (options.store.appendEventWithResult(lifecycleEvent).inserted === true) {
            appendedEvents += 1
          }
        }
        if (options.store.appendEventWithResult(event).inserted === true) {
          appendedEvents += 1
        }
      }

      const result = {
        observation,
        appendedEvents,
        status: readOneShotSyncStatus({ store: options.store, rootId: options.rootId }),
      }
      yield* annotateSpan({
        ...statusSpanAttributes(result.status),
        [spanAttr.appendedEvents]: appendedEvents,
        [spanAttr.cappedAtLimit]: observation.query.cappedAtLimit,
        [spanAttr.eventCount]: observation.events.length,
        [spanAttr.incompletePropertyCount]: observation.properties.incomplete,
        [spanAttr.queryComplete]: observation.query.complete,
        [spanAttr.queryPageCount]: observation.query.pages,
        [spanAttr.rowCount]: observation.query.rows,
      })
      return result
    }),
)

/** Establish a local sync root from an existing Notion data source. This path is remote-to-local only and never scans local artifacts or executes remote writes. */
export const establishFromNotion = Effect.fn(spanNames.syncEstablishFromNotion)(
  (
    options: EstablishFromNotionOptions,
  ): Effect.Effect<
    EstablishFromNotionResult,
    NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* annotateOneShotStart({
        operation: 'establish-from-notion',
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      })
      yield* reportSyncProgress({
        _tag: 'phase',
        phase: 'preparing',
        message: 'Establishing local replica',
      })
      const gateway = yield* NotionDataSourceGateway
      yield* gateway.retrieveDataSource(options.dataSourceId)
      const binding = initOneShotSync(options)
      const pull = yield* pullOneShotSync(options)
      const status = readOneShotSyncStatus({ store: options.store, rootId: options.rootId })
      yield* annotateSpan({
        ...statusSpanAttributes(status),
        [spanAttr.appendedEvents]: pull.appendedEvents,
        [spanAttr.queryComplete]: pull.observation.query.complete,
        [spanAttr.rowCount]: pull.observation.query.rows,
      })
      return {
        mode: 'establish-from-notion',
        remoteValidated: true,
        binding,
        pull,
        pushed: false,
        status,
      }
    }),
)

/** Plan and execute local-to-remote changes: observe the local workspace, run intents through the planner, and drain the outbox up to `maxExecutorSteps`. */
export const pushOneShotSync = Effect.fn(spanNames.syncPush)(
  (
    options: OneShotPushOptions,
  ): Effect.Effect<
    OneShotPushResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* annotateOneShotStart({
        operation: 'push',
        rootId: options.rootId,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.maxExecutorSteps === undefined
          ? {}
          : { maxExecutorSteps: options.maxExecutorSteps }),
        ...(options.leaseDurationMs === undefined
          ? {}
          : { leaseDurationMs: options.leaseDurationMs }),
      })
      yield* reportSyncProgress({ _tag: 'phase', phase: 'pushing' })
      const now = options.now ?? (() => new Date())
      const body = yield* PageBodySyncPort
      const local =
        options.materializeBodies === false
          ? { observations: [] }
          : (options.localWorkspaceObservation ??
            (yield* observeLocalWorkspace(options.workspaceRoot)))
      const summaries: OneShotPlanSummary[] = []

      /*
       * Read the planner snapshot with the authority-mode overlay AND the SM5c
       * local-convergence property verdicts applied. The convergence verdicts set
       * `localConvergence` per `(pageId, propertyId)` so a divergent SQLite-vs-`.nmd`
       * property blocks as `LocalSurfaceDisagreement` through the shared proof core.
       */
      const readConvergedSnapshot = (): PlannerProjectionSnapshot => {
        const withMode = withAuthorityMode({
          snapshot: options.store.readPlannerProjectionSnapshot(options.rootId),
          authorityMode: options.authorityMode,
        })
        return options.convergenceVerdicts === undefined || options.convergenceVerdicts.length === 0
          ? withMode
          : {
              ...withMode,
              properties: applyConvergenceVerdicts({
                properties: withMode.properties,
                verdicts: options.convergenceVerdicts,
              }),
            }
      }

      yield* reportSyncProgress({ _tag: 'phase', phase: 'planning' })
      for (const intent of options.localIntents ?? []) {
        const snapshot = readConvergedSnapshot()
        summaries.push(
          appendDecision({
            store: options.store,
            rootId: options.rootId,
            decision: planIntent({ snapshot, intent }),
            ...('pageId' in intent ? { pageId: intent.pageId } : {}),
            now,
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          }),
        )
      }

      for (const observation of local.observations) {
        const snapshot = readConvergedSnapshot()
        const bodySurface = snapshot.bodies.find(
          (candidate) => candidate.pageId === observation.pageId,
        )
        if (observation.state === 'delete-candidate') {
          summaries.push(
            appendDecision({
              store: options.store,
              rootId: options.rootId,
              decision: planIntent({
                snapshot,
                intent: localDeleteIntentFromObservation(observation),
              }),
              pageId: observation.pageId,
              now,
              ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
            }),
          )
          continue
        }

        if (
          bodySurface === undefined ||
          renderedBodyDigest(bodySurface.pointer.identity) === observation.contentHash
        ) {
          continue
        }

        /*
         * The `.nmd` artifact is the SINGLE local body surface and the body ADAPTER
         * owns it (decision 0021). Body is NOT routed through the property
         * convergence engine — that was a false symmetry (the engine adds no handling
         * the adapter does not already do). The adapter (`planLocalChange`) is
         * authoritative for ALL body semantics: stale-vs-live remote, the safety
         * contract, and `BodyPushCommand` construction; a body conflict is raised by
         * the adapter below (`conflictKind: 'body'`) and resolved via keep-local
         * re-push / keep-remote re-materialize.
         */
        const baseBodyPointer = bodySurface.pointer
        const bodyPlan = yield* body.planLocalChange({
          _tag: 'BodyLocalChangeInput',
          pageId: observation.pageId,
          baseBodyPointer,
          localBodyHash: observation.contentHash,
          localBodyPath: observation.path,
          ...(observation.bodyContent === undefined
            ? {}
            : { localBodyContent: observation.bodyContent }),
        })

        if (bodyPlan._tag === 'BodyConflict') {
          const inserted =
            options.dryRun === true
              ? false
              : options.store.appendEventWithResult(
                  makeConflictRaisedEvent({
                    rootId: options.rootId,
                    pageId: observation.pageId,
                    surface: bodySurfaceKey(observation.pageId),
                    // EVIDENCE digest: the body adapter's `body` conflict is a
                    // remote-reconciliation output (decision 0021), so it stays in the
                    // same evidence space as the adapter command and the
                    // `_nds_body_pointer` projection.
                    baseHash: bodyPointerIdentityDigest(bodyPlan.baseBodyPointer),
                    localHash: bodyPlan.localBodyHash,
                    remoteHash: bodyPlan.remoteBodyHash,
                    conflictKind: 'body',
                    message: bodyPlan.message ?? 'Body adapter reported a local body conflict',
                    now,
                  }),
                ).inserted
          summaries.push({
            decisions: [],
            appendedEvents: inserted === true ? 1 : 0,
            enqueuedCommands: 0,
            blocked: 0,
            conflicts: inserted === true ? 1 : 0,
          })
          continue
        }

        const command = bodyPushCommandFromLocalChange({
          pageId: bodyPlan.pageId,
          baseBodyPointer: bodyPlan.baseBodyPointer,
          localBodyHash: bodyPlan.nextBodyHash,
          ...(bodyPlan.localBodyPath === undefined
            ? {}
            : { localBodyPath: bodyPlan.localBodyPath }),
          ...(bodyPlan.localBodyContent === undefined
            ? {}
            : { localBodyContent: bodyPlan.localBodyContent }),
        })
        const intent: BodyEditIntent = {
          _tag: 'body-edit',
          intentEventId: intentEventIdFor(`body:${observation.pageId}:${observation.contentHash}`),
          commandKey: commandKeyFor(`body:${observation.pageId}:${observation.contentHash}`),
          surface: bodySurfaceKey(observation.pageId),
          pageId: observation.pageId,
          command,
          // EVIDENCE digest: `intent.baseHash` feeds the planner's
          // `guardStaleSurfaceBase`, which compares it against
          // `bodySurface.currentHash` — read straight from the `_nds_body_pointer`
          // projection, which stays on the evidence digest (the adapter's
          // stale-vs-remote space, decision 0021). Both sides of that guard MUST
          // share a space; a rendered base here would false-fire `StaleSurfaceBase`
          // on every evidence-backed pointer.
          baseHash: bodyPointerIdentityDigest(bodyPlan.baseBodyPointer),
          desiredHash: bodyPlan.nextBodyHash,
        }
        summaries.push(
          appendDecision({
            store: options.store,
            rootId: options.rootId,
            decision: planIntent({
              snapshot: withAuthorityMode({
                snapshot: options.store.readPlannerProjectionSnapshot(options.rootId),
                authorityMode: options.authorityMode,
              }),
              intent,
            }),
            pageId: observation.pageId,
            now,
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          }),
        )
      }

      const maxExecutorSteps = options.maxExecutorSteps ?? 32
      const results: OutboxExecutionResult[] = []
      let maxStepsReached = false

      if (options.dryRun !== true) {
        for (let step = 0; step < maxExecutorSteps; step += 1) {
          const result = yield* executeOutboxOnce({
            store: options.store,
            rootId: options.rootId,
            leaseToken: options.leaseToken ?? `one-shot:${options.rootId}`,
            leaseDurationMs: options.leaseDurationMs ?? 60_000,
          })
          results.push(result)
          yield* reportSyncProgress({
            _tag: 'executor-step',
            current: step + 1,
            max: maxExecutorSteps,
            result: result._tag,
          })
          if (result._tag === 'idle') {
            break
          }
          maxStepsReached = step === maxExecutorSteps - 1
        }
      }

      const result = {
        localObservations: local.observations.length,
        plan: mergePlanSummaries(summaries),
        executor: {
          steps: results.length,
          maxStepsReached,
          results,
        },
        status: readOneShotSyncStatus({ store: options.store, rootId: options.rootId }),
      }
      yield* annotateSpan({
        ...statusSpanAttributes(result.status),
        [spanAttr.appendedEvents]: result.plan.appendedEvents,
        [spanAttr.blockedCount]: result.plan.blocked,
        [spanAttr.conflictCount]: result.plan.conflicts,
        [spanAttr.enqueuedCommands]: result.plan.enqueuedCommands,
        [spanAttr.executorSteps]: result.executor.steps,
        [spanAttr.localObservationCount]: result.localObservations,
        [spanAttr.maxStepsReached]: result.executor.maxStepsReached,
      })
      return result
    }),
)

/** Run a full local-capture-first sync cycle in a single Effect: preserve local artifacts, observe remote, plan local changes, execute outbox. */
export const syncOneShot = Effect.fn(spanNames.syncOneShot)(
  (
    options: OneShotSyncOptions,
  ): Effect.Effect<
    OneShotSyncResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* annotateOneShotStart({
        operation: 'sync',
        rootId: options.rootId,
        dataSourceId: options.dataSourceId,
        ...(options.maxExecutorSteps === undefined
          ? {}
          : { maxExecutorSteps: options.maxExecutorSteps }),
        ...(options.leaseDurationMs === undefined
          ? {}
          : { leaseDurationMs: options.leaseDurationMs }),
      })
      // Mirror (`remote`-authority) reconcile: run pull-only, skipping BOTH push
      // passes so no local intent — property, lifecycle (archive/restore), OR row
      // create — is ever planned, enqueued, or executed against the gateway. The
      // pull pass alone converges remote→local (SM5.4). This is the SINGLE
      // chokepoint that makes the mirror guarantee uniform across one-shot `sync`
      // AND the watch daemon: `authorityMode === 'remote'` gates here regardless of
      // caller, so a remote-mode workspace never pushes even though the planner's
      // per-property `RemoteAuthoritativeDrift` block never covered the
      // lifecycle/create paths. The explicit `pullOnly` flag remains for the daemon
      // (defense-in-depth) and standalone callers without an authority mode.
      const mirrorPullOnly = options.pullOnly === true || options.authorityMode === 'remote'
      const local =
        options.materializeBodies === false || mirrorPullOnly === true
          ? { observations: [] }
          : yield* observeLocalWorkspace(options.workspaceRoot)
      const localWorkspaceChanged = hasLocalWorkspaceChange({
        observations: local.observations,
        store: options.store,
        rootId: options.rootId,
      })
      const prePullPush =
        mirrorPullOnly === true ||
        localWorkspaceChanged === false ||
        options.deferLocalPlanningUntilAfterPull === true
          ? undefined
          : yield* pushOneShotSync({
              ...options,
              localWorkspaceObservation: local,
              maxExecutorSteps: 0,
            })
      const pull = yield* pullOneShotSync({
        ...options,
        ...(localWorkspaceChanged === true ? { materializeBodyArtifacts: false } : {}),
      })
      const pushAfterPull =
        mirrorPullOnly === true
          ? emptyPushResult({ store: options.store, rootId: options.rootId })
          : yield* pushOneShotSync({
              ...options,
              localWorkspaceObservation:
                localWorkspaceChanged === true && options.deferLocalPlanningUntilAfterPull === true
                  ? local
                  : { observations: [] },
            })
      const push =
        prePullPush === undefined
          ? pushAfterPull
          : {
              ...pushAfterPull,
              localObservations: prePullPush.localObservations + pushAfterPull.localObservations,
              plan: mergePlanSummaries([prePullPush.plan, pushAfterPull.plan]),
            }
      const status = readOneShotSyncStatus({ store: options.store, rootId: options.rootId })
      yield* reportSyncProgress({ _tag: 'phase', phase: 'complete' })

      yield* annotateSpan({
        ...statusSpanAttributes(status),
        [spanAttr.appendedEvents]: pull.appendedEvents + push.plan.appendedEvents,
        [spanAttr.blockedCount]: push.plan.blocked,
        [spanAttr.conflictCount]: push.plan.conflicts,
        [spanAttr.enqueuedCommands]: push.plan.enqueuedCommands,
        [spanAttr.executorSteps]: push.executor.steps,
        [spanAttr.queryComplete]: pull.observation.query.complete,
        [spanAttr.rowCount]: pull.observation.query.rows,
      })
      return { pull, push, status }
    }),
)
