import { Effect, Schema } from 'effect'

import {
  bodySurfaceKey,
  pageSurfaceKey,
  queryContractHash as computeQueryContractHash,
  querySurfaceKey,
} from '../core/canonical.ts'
import {
  BodyPointer,
  Hash,
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
import {
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePort,
} from '../core/ports.ts'
import { reportSyncProgress } from '../core/progress.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from '../core/status.ts'
import {
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
  statusSpanAttributes,
} from '../observability/observability.ts'
import {
  planIntent,
  type BodyEditIntent,
  type LocalDeleteIntent,
  type PlanDecision,
  type PlannerIntent,
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
}

/** Combined options for `syncOneShot`, merging pull and push settings into a single pass. */
export type OneShotSyncOptions = OneShotPullOptions &
  Pick<
    OneShotPushOptions,
    'localIntents' | 'materializeBodies' | 'maxExecutorSteps' | 'leaseToken' | 'leaseDurationMs'
  > & {
    readonly deferLocalPlanningUntilAfterPull?: boolean
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

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const fallbackHash = (_value: string) => decode({ schema: Hash, value: `sha256:${'0'.repeat(64)}` })

const pageIdFromSurface = (surface: string): typeof PageId.Type => {
  const match = /^page:([^:]+)/.exec(surface)
  return decode({ schema: PageId, value: match?.[1] ?? 'unknown-page' })
}

const propertyIdFromSurface = (surface: string): typeof PropertyId.Type | undefined => {
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
  readonly pageId?: typeof PageId.Type
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

const mergePlanSummaries = (summaries: ReadonlyArray<OneShotPlanSummary>): OneShotPlanSummary => ({
  decisions: summaries.flatMap((summary) => summary.decisions),
  appendedEvents: summaries.reduce((sum, summary) => sum + summary.appendedEvents, 0),
  enqueuedCommands: summaries.reduce((sum, summary) => sum + summary.enqueuedCommands, 0),
  blocked: summaries.reduce((sum, summary) => sum + summary.blocked, 0),
  conflicts: summaries.reduce((sum, summary) => sum + summary.conflicts, 0),
})

const localDeleteIntentFromObservation = (observation: {
  readonly pageId: typeof PageId.Type
  readonly contentHash: typeof Hash.Type
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
  Effect.annotateCurrentSpan(
    spanAttributes({
      [spanAttr.spanLabel]: spanLabel(input.operation, shortSpanId(input.rootId)),
      [spanAttr.processRole]: 'library',
      [spanAttr.operation]: input.operation,
      [spanAttr.rootId]: input.rootId,
      [spanAttr.dataSourceId]: input.dataSourceId,
      [spanAttr.dryRun]: input.dryRun === true,
      [spanAttr.maxExecutorSteps]: input.maxExecutorSteps,
      [spanAttr.leaseDurationMs]: input.leaseDurationMs,
    }),
  )

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
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel('query-absence', shortSpanId(options.rootId)),
          [spanAttr.rootId]: options.rootId,
          [spanAttr.dataSourceId]: options.dataSourceId,
        }),
      )
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
      const observation = yield* observeRemoteDataSource({
        ...options,
        ...(options.dryRun === true ? { materializeBodies: false } : {}),
        startCursor: options.startCursor ?? resumeCursorForPull(options),
      })
      let appendedEvents = 0
      for (const event of observation.events) {
        if (options.dryRun === true) continue
        if (options.store.appendEventWithResult(event).inserted === true) {
          appendedEvents += 1
        }
      }
      const absenceEvents = yield* disappearanceCandidateEvents({ options, observation })
      for (const event of absenceEvents) {
        if (options.dryRun === true) continue
        if (options.store.appendEventWithResult(event).inserted === true) {
          appendedEvents += 1
        }
      }

      const result = {
        observation,
        appendedEvents,
        status: readOneShotSyncStatus({ store: options.store, rootId: options.rootId }),
      }
      yield* Effect.annotateCurrentSpan({
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
      yield* Effect.annotateCurrentSpan({
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

      yield* reportSyncProgress({ _tag: 'phase', phase: 'planning' })
      for (const intent of options.localIntents ?? []) {
        const snapshot = options.store.readPlannerProjectionSnapshot(options.rootId)
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
        const snapshot = options.store.readPlannerProjectionSnapshot(options.rootId)
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

        if (bodySurface === undefined || bodySurface.currentHash === observation.contentHash) {
          continue
        }

        const baseBodyPointer = decode({
          schema: BodyPointer,
          value: {
            _tag: 'BodyPointer',
            pageId: observation.pageId,
            bodyHash: bodySurface.currentHash,
            observedAt: now().toISOString(),
            safety: bodySurface.safety,
          },
        })
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
                    baseHash: bodyPlan.baseBodyPointer.bodyHash,
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
          baseHash: bodyPlan.baseBodyPointer.bodyHash,
          desiredHash: bodyPlan.nextBodyHash,
        }
        summaries.push(
          appendDecision({
            store: options.store,
            rootId: options.rootId,
            decision: planIntent({
              snapshot: options.store.readPlannerProjectionSnapshot(options.rootId),
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
      yield* Effect.annotateCurrentSpan({
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
      const local =
        options.materializeBodies === false
          ? { observations: [] }
          : yield* observeLocalWorkspace(options.workspaceRoot)
      const localWorkspaceChanged = hasLocalWorkspaceChange({
        observations: local.observations,
        store: options.store,
        rootId: options.rootId,
      })
      const prePullPush =
        localWorkspaceChanged === false || options.deferLocalPlanningUntilAfterPull === true
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
      const pushAfterPull = yield* pushOneShotSync({
        ...options,
        localWorkspaceObservation:
          localWorkspaceChanged === true && options.deferLocalPlanningUntilAfterPull !== true
            ? { observations: [] }
            : local,
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

      yield* Effect.annotateCurrentSpan({
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
