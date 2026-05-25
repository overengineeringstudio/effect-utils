import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeUnsupportedPageBodySyncPort } from '../body-adapter.ts'
import { bodySurfaceKey } from '../canonical.ts'
import type { BodyPushCommand as BodyPushCommandType } from '../commands.ts'
import { AbsolutePath, WorkspaceRelativePath, type BodySafetySnapshot } from '../domain.ts'
import { BodySyncError } from '../errors.ts'
import { RowObserved } from '../events.ts'
import { executeOutboxOnce } from '../executor.ts'
import { makeFakeLocalWorkspacePort, presentArtifactObservation } from '../local-workspace.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../ports.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync } from '../sync.ts'
import {
  appendPlannedCommand,
  bodyPointer,
  bodySafety,
  defaultQueryContract,
  decode,
  fakeBodyPage,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-body-adapter')
const bodyPath = decode(WorkspaceRelativePath, 'page-1.nmd')
const implementedBodyAdapterScenarioIds = new Set<ScenarioId>([
  'NDS-L2-body-adapter-fail-closed-boundary',
])

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: NotionDataSourceGatewayShape
    readonly body: PageBodySyncPortShape
    readonly workspace: LocalWorkspacePortShape
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body),
      Effect.provideService(LocalWorkspacePort, input.workspace),
    ),
  )

const trackedWorkspace = () => {
  const base = makeFakeLocalWorkspacePort()
  let materializeCalls = 0

  return {
    materializeCalls: () => materializeCalls,
    workspace: {
      ...base,
      materialize: (plan) =>
        Effect.sync(() => {
          materializeCalls += 1
          return plan
        }).pipe(Effect.zipRight(base.materialize(plan))),
    } satisfies LocalWorkspacePortShape,
  }
}

const bodyPortWithPushLedger = (body: PageBodySyncPortShape) => {
  const pushed: BodyPushCommandType[] = []

  return {
    pushed,
    body: {
      ...body,
      push: (command) =>
        Effect.sync(() => {
          pushed.push(command)
          return command
        }).pipe(Effect.zipRight(body.push(command))),
    } satisfies PageBodySyncPortShape,
  }
}

const pullOptions = (store: ReturnType<typeof makeStoreFixture>['store']) => ({
  store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot,
  queryContract: defaultQueryContract(),
  schemaProperties: [],
  now: makeFakeClock().now,
})

const assertNoGatewayMutations = (ledger: ReturnType<typeof makeFakeGatewayHarness>['ledger']) => {
  expect(ledger.attemptedPatchPageProperties).toEqual([])
  expect(ledger.attemptedPatchDataSourceSchemas).toEqual([])
  expect(ledger.attemptedTrashPages).toEqual([])
  expect(ledger.attemptedRestorePages).toEqual([])
}

const appendObservedBodyProjection = (
  store: ReturnType<typeof makeStoreFixture>['store'],
  safety: BodySafetySnapshot,
) => {
  store.appendEvent(
    decode(RowObserved, {
      _tag: 'RowObserved',
      eventId: `body-adapter-row-observed:${hash(JSON.stringify(safety))}`,
      rootId: testIds.rootId,
      sequence: '0',
      codecVersion: 'v1',
      family: 'RemoteObserved',
      eventType: 'RowObserved',
      idempotencyKey: `body-adapter-row-observed:${hash(JSON.stringify(safety))}`,
      surface: bodySurfaceKey(testIds.pageId),
      causedByEventIds: [],
      payloadHash: hash('body-adapter-row-observed'),
      payload: {
        _tag: 'VersionedJson',
        codecVersion: 'v1',
        canonicalJson: JSON.stringify({
          bodyPath,
          safety,
          sidecarIdentityProven: true,
          ownWriteMaterializationIds: [],
        }),
      },
      observedAt: '2026-05-25T00:00:00.000Z',
      dataSourceId: testIds.dataSourceId,
      pageId: testIds.pageId,
      propertiesHash: hash('properties-a'),
      bodyPointer: {
        _tag: 'BodyPointer',
        pageId: testIds.pageId,
        bodyHash: hash('body-a'),
        observedAt: '2026-05-25T00:00:00.000Z',
        safety,
      },
      inTrash: false,
    }),
  )
}

describe('body adapter E2E boundary', () => {
  it('keeps body adapter scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/body-adapter.e2e.test.ts',
        implementedScenarioIds: implementedBodyAdapterScenarioIds,
      }),
    ).toEqual([])
  })

  it('fails closed before materializing bodies when no NotionMD body adapter is configured', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const { workspace, materializeCalls } = trackedWorkspace()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: makeFakeClock().now,
      })
      const before = storeFixture.store.replay(testIds.rootId)

      await expect(
        runWithPorts(Effect.flip(pullOneShotSync(pullOptions(storeFixture.store))), {
          gateway: gatewayHarness.gateway,
          body: makeUnsupportedPageBodySyncPort(),
          workspace,
        }),
      ).resolves.toMatchObject({
        _tag: 'BodySyncError',
        operation: 'observe',
        pageId: testIds.pageId,
        message: expect.stringContaining('No NotionMD page body adapter'),
      })

      expect(materializeCalls()).toBe(0)
      expect(storeFixture.store.replay(testIds.rootId)).toEqual(before)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])
      assertNoGatewayMutations(gatewayHarness.ledger)
    } finally {
      storeFixture.cleanup()
    }
  })

  it.each([
    [
      'truncated markdown',
      bodySafety({ truncated: true }),
      'BodyLossyRemote',
      'Remote markdown body is truncated',
    ],
    [
      'unknown markdown blocks',
      bodySafety({ unknownBlockCause: 'unknown' }),
      'MarkdownUnknownBlocksAmbiguous',
      'Unknown markdown blocks have ambiguous preservation semantics',
    ],
    [
      'ambiguous markdown update selection',
      bodySafety({ selection: 'ambiguous' }),
      'MarkdownSelectionAmbiguous',
      'Markdown update selection is ambiguous',
    ],
    [
      'implicit child page deletion',
      bodySafety({ wouldDeleteChildren: true }),
      'MarkdownWouldDeleteChildren',
      'Markdown update would delete child pages or databases',
    ],
    [
      'unsupported synced page update',
      bodySafety({ syncedPageUnsupported: true }),
      'MarkdownSyncedPageUnsupported',
      'Synced page body update is unsupported',
    ],
    [
      'delegated adapter conflict',
      bodySafety({ adapterConflict: true }),
      'BodyAdapterConflict',
      'Body adapter reported a delegated conflict',
    ],
  ] as const)(
    'records a body conflict and no body push for %s',
    async (_name, safety: BodySafetySnapshot, reason, message) => {
      const storeFixture = makeStoreFixture({ mode: 'memory' })
      const gatewayHarness = makeFakeGatewayHarness()
      const bodyPort = makeHarnessPorts({ bodyPages: [fakeBodyPage({ safety })] }).body
      const { body: trackedBody, pushed } = bodyPortWithPushLedger(bodyPort)

      try {
        initOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          now: makeFakeClock().now,
        })

        appendObservedBodyProjection(storeFixture.store, safety)
        await expect(
          Effect.runPromise(
            bodyPort.planLocalChange({
              _tag: 'BodyLocalChangeInput',
              pageId: testIds.pageId,
              baseBodyPointer: { ...bodyPointer(), safety },
              localBodyHash: hash('body-local-edit'),
            }),
          ),
        ).resolves.toMatchObject({
          _tag: 'BodyConflict',
          reason,
          message,
        })

        const result = await runWithPorts(
          pushOneShotSync({
            store: storeFixture.store,
            rootId: testIds.rootId,
            workspaceRoot,
            now: makeFakeClock().now,
          }),
          {
            gateway: gatewayHarness.gateway,
            body: trackedBody,
            workspace: makeHarnessPorts({
              localObservations: [
                presentArtifactObservation({
                  pageId: testIds.pageId,
                  path: bodyPath,
                  contentHash: hash('body-local-edit'),
                  observedAt: bodyPointer().observedAt,
                }),
              ],
            }).workspace,
          },
        )
        const conflicts = storeFixture.store
          .replay(testIds.rootId)
          .filter((event) => event._tag === 'ConflictRaised')

        expect(result.plan).toMatchObject({
          enqueuedCommands: 0,
          conflicts: 1,
        })
        expect(result.executor.results).toEqual([{ _tag: 'idle' }])
        expect(pushed).toEqual([])
        expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])
        expect(conflicts.at(-1)).toMatchObject({
          _tag: 'ConflictRaised',
          conflictKind: 'body',
          pageId: testIds.pageId,
          remoteHash: hash('body-a'),
        })
        expect(conflicts.at(-1)?.payload.canonicalJson).toContain(message)
        assertNoGatewayMutations(gatewayHarness.ledger)
      } finally {
        storeFixture.cleanup()
      }
    },
  )

  it('keeps queued body pushes unsettled when the adapter is absent', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const unsupported = makeUnsupportedPageBodySyncPort()
    const { body, pushed } = bodyPortWithPushLedger(unsupported)
    const baseBodyPointer = bodyPointer()
    const command: BodyPushCommandType = {
      _tag: 'BodyPushCommand',
      commandId: testIds.commandId,
      pageId: testIds.pageId,
      baseBodyPointer,
      nextBodyHash: hash('body-next'),
    }

    try {
      appendPlannedCommand(storeFixture.store, {
        rootId: testIds.rootId,
        commandId: testIds.commandId,
        commandKey: testIds.commandKey,
        intentEventId: testIds.intentEventId,
        surface: bodySurfaceKey(testIds.pageId),
        command,
        baseHash: baseBodyPointer.bodyHash,
        desiredHash: hash('body-next'),
        preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'BodyAdapterConflict'],
      })

      await expect(
        Effect.runPromise(
          executeOutboxOnce({
            store: storeFixture.store,
            rootId: testIds.rootId,
            leaseToken: 'body-adapter-e2e',
            leaseDurationMs: 60_000,
          }).pipe(
            Effect.provideService(NotionDataSourceGateway, gatewayHarness.gateway),
            Effect.provideService(PageBodySyncPort, body),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'failed',
        commandId: testIds.commandId,
        guard: 'CurrentSurfaceMissing',
        attemptState: 'retryable',
      })

      expect(pushed).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          commandTag: 'BodyPush',
          state: 'retryable',
          attemptCount: 1,
          settlementEventId: undefined,
        },
      ])
      assertNoGatewayMutations(gatewayHarness.ledger)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('does not classify unsupported body adapter operations as successful extraction or rendering', async () => {
    const unsupported = makeUnsupportedPageBodySyncPort()

    await expect(
      Effect.runPromise(
        Effect.flip(
          unsupported.repair({
            _tag: 'BodyRepairInput',
            pageId: testIds.pageId,
            currentBodyPointer: bodyPointer(),
          }),
        ),
      ),
    ).resolves.toBeInstanceOf(BodySyncError)
  })
})
