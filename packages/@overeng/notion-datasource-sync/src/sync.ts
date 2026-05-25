import { Effect, Schema } from 'effect'

import { bodySurfaceKey, pageSurfaceKey } from './canonical.ts'
import { BodyPointer, Hash, PageId, type AbsolutePath } from './domain.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from './errors.ts'
import { executeOutboxOnce, type OutboxExecutionResult } from './executor.ts'
import {
  bodyPushCommandFromLocalChange,
  commandIdFor,
  commandKeyFor,
  intentEventIdFor,
  makeConflictRaisedEvent,
  makePlannerEvent,
  makeRemoteWritePlannedEvent,
  makeSyncBindingRecordedEvent,
  observeLocalWorkspace,
  observeRemoteDataSource,
  type RemoteObservationOptions,
  type RemoteObservationResult,
} from './observation.ts'
import {
  planIntent,
  type BodyEditIntent,
  type LocalDeleteIntent,
  type PlanDecision,
  type PlannerIntent,
} from './planner.ts'
import { PageBodySyncPort, type LocalWorkspacePort, type NotionDataSourceGateway } from './ports.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from './status.ts'
import { pageLifecycleHash } from './store-projections.ts'
import type { NotionSyncStore } from './store.ts'

export type OneShotInitOptions = {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly dataSourceId: RemoteObservationOptions['dataSourceId']
  readonly workspaceRoot: AbsolutePath
  readonly storeIdentity?: string
  readonly now?: () => Date
  readonly dryRun?: boolean
}

export type OneShotPullOptions = {
  readonly store: NotionSyncStore
} & RemoteObservationOptions

export type OneShotPushOptions = {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly workspaceRoot: AbsolutePath
  readonly localIntents?: ReadonlyArray<PlannerIntent>
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
}

export type OneShotSyncOptions = OneShotPullOptions &
  Pick<OneShotPushOptions, 'localIntents' | 'maxExecutorSteps' | 'leaseToken' | 'leaseDurationMs'>

export type OneShotPlanSummary = {
  readonly decisions: ReadonlyArray<PlanDecision>
  readonly appendedEvents: number
  readonly enqueuedCommands: number
  readonly blocked: number
  readonly conflicts: number
}

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

export type OneShotPullResult = {
  readonly observation: RemoteObservationResult
  readonly appendedEvents: number
  readonly status: OneShotSyncStatus
}

export type OneShotSyncResult = {
  readonly pull: OneShotPullResult
  readonly push: OneShotPushResult
  readonly status: OneShotSyncStatus
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const fallbackHash = (_value: string) => decode(Hash, `sha256:${'0'.repeat(64)}`)

const pageIdFromSurface = (surface: string): typeof PageId.Type => {
  const match = /^page:([^:]+)/.exec(surface)
  return decode(PageId, match?.[1] ?? 'unknown-page')
}

const appendDecision = ({
  store,
  rootId,
  decision,
  pageId,
  now,
}: {
  readonly store: NotionSyncStore
  readonly rootId: RemoteObservationOptions['rootId']
  readonly decision: PlanDecision
  readonly pageId?: typeof PageId.Type
  readonly now: () => Date
}): OneShotPlanSummary => {
  switch (decision._tag) {
    case 'AppendEvents': {
      let appendedEvents = 0
      for (const plannerEvent of decision.events) {
        const event = makePlannerEvent({ rootId, event: plannerEvent, now })
        if (event === undefined) continue
        store.appendEvent(event)
        appendedEvents += 1
      }
      return {
        decisions: [decision],
        appendedEvents,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 0,
      }
    }
    case 'EnqueueCommands':
      for (const command of decision.commands) {
        store.appendEvent(makeRemoteWritePlannedEvent(command, now))
      }
      return {
        decisions: [decision],
        appendedEvents: 0,
        enqueuedCommands: decision.commands.length,
        blocked: 0,
        conflicts: 0,
      }
    case 'OpenConflict': {
      const surface = decision.conflict.localSurface
      store.appendEvent(
        makeConflictRaisedEvent({
          rootId,
          pageId: pageId ?? pageIdFromSurface(surface),
          surface,
          baseHash: decision.conflict.baseHash ?? fallbackHash('missing-base'),
          localHash: decision.conflict.localHash ?? fallbackHash('missing-local'),
          remoteHash: decision.conflict.remoteHash ?? fallbackHash('missing-remote'),
          message: decision.conflict.message,
          now,
        }),
      )
      return {
        decisions: [decision],
        appendedEvents: 1,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 1,
      }
    }
    case 'BlockedByGuard':
      return {
        decisions: [decision],
        appendedEvents: 0,
        enqueuedCommands: 0,
        blocked: 1,
        conflicts: 0,
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
  desiredHash: pageLifecycleHash(observation.pageId, true),
  explicitDestructiveIntent: false,
  policy: 'candidateOnly',
  directRetrieve: 'accessible',
})

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

export const pullOneShotSync = Effect.fn('NotionDatasourceSync.Sync.pullOneShotSync')(
  (
    options: OneShotPullOptions,
  ): Effect.Effect<
    OneShotPullResult,
    NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const observation = yield* observeRemoteDataSource(options)
      for (const event of observation.events) {
        options.store.appendEvent(event)
      }

      return {
        observation,
        appendedEvents: observation.events.length,
        status: readOneShotSyncStatus({ store: options.store, rootId: options.rootId }),
      }
    }),
)

export const pushOneShotSync = Effect.fn('NotionDatasourceSync.Sync.pushOneShotSync')(
  (
    options: OneShotPushOptions,
  ): Effect.Effect<
    OneShotPushResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const now = options.now ?? (() => new Date())
      const body = yield* PageBodySyncPort
      const local = yield* observeLocalWorkspace(options.workspaceRoot)
      const summaries: OneShotPlanSummary[] = []

      for (const intent of options.localIntents ?? []) {
        const snapshot = options.store.readPlannerProjectionSnapshot(options.rootId)
        summaries.push(
          appendDecision({
            store: options.store,
            rootId: options.rootId,
            decision: planIntent(snapshot, intent),
            ...('pageId' in intent ? { pageId: intent.pageId } : {}),
            now,
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
              decision: planIntent(snapshot, localDeleteIntentFromObservation(observation)),
              pageId: observation.pageId,
              now,
            }),
          )
          continue
        }

        if (bodySurface === undefined || bodySurface.currentHash === observation.contentHash) {
          continue
        }

        const baseBodyPointer = decode(BodyPointer, {
          _tag: 'BodyPointer',
          pageId: observation.pageId,
          bodyHash: bodySurface.currentHash,
          observedAt: now().toISOString(),
          safety: bodySurface.safety,
        })
        const bodyPlan = yield* body.planLocalChange({
          _tag: 'BodyLocalChangeInput',
          pageId: observation.pageId,
          baseBodyPointer,
          localBodyHash: observation.contentHash,
        })

        if (bodyPlan._tag === 'BodyConflict') {
          options.store.appendEvent(
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
          )
          summaries.push({
            decisions: [],
            appendedEvents: 1,
            enqueuedCommands: 0,
            blocked: 0,
            conflicts: 1,
          })
          continue
        }

        const command = bodyPushCommandFromLocalChange({
          pageId: bodyPlan.pageId,
          baseBodyPointer: bodyPlan.baseBodyPointer,
          localBodyHash: bodyPlan.nextBodyHash,
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
            decision: planIntent(
              options.store.readPlannerProjectionSnapshot(options.rootId),
              intent,
            ),
            pageId: observation.pageId,
            now,
          }),
        )
      }

      const maxExecutorSteps = options.maxExecutorSteps ?? 32
      const results: OutboxExecutionResult[] = []
      let maxStepsReached = false

      for (let step = 0; step < maxExecutorSteps; step += 1) {
        const result = yield* executeOutboxOnce({
          store: options.store,
          rootId: options.rootId,
          leaseToken: options.leaseToken ?? `one-shot:${options.rootId}`,
          leaseDurationMs: options.leaseDurationMs ?? 60_000,
        })
        results.push(result)
        if (result._tag === 'idle') {
          break
        }
        maxStepsReached = step === maxExecutorSteps - 1
      }

      return {
        localObservations: local.observations.length,
        plan: mergePlanSummaries(summaries),
        executor: {
          steps: results.length,
          maxStepsReached,
          results,
        },
        status: readOneShotSyncStatus({ store: options.store, rootId: options.rootId }),
      }
    }),
)

export const syncOneShot = Effect.fn('NotionDatasourceSync.Sync.syncOneShot')(
  (
    options: OneShotSyncOptions,
  ): Effect.Effect<
    OneShotSyncResult,
    LocalStoreError | NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const pull = yield* pullOneShotSync(options)
      const push = yield* pushOneShotSync(options)
      const status = readOneShotSyncStatus({ store: options.store, rootId: options.rootId })

      return { pull, push, status }
    }),
)
