import { join } from 'node:path'

import { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { PatchPagePropertiesCommand, PagePropertyItemPage } from '../commands.ts'
import {
  AbsolutePath,
  BodyPointer,
  WorkspaceRelativePath,
  type Hash as HashType,
  type PageId as PageIdType,
  type PropertyId as PropertyIdType,
} from '../domain.ts'
import { allGatewayCapabilities } from '../gateway.ts'
import {
  canonicalizeWorkspaceRelativePath,
  filesystemWorkspacePageSidecarPath,
  makeFilesystemLocalWorkspacePort,
} from '../local-workspace.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../ports.ts'
import { hashStoreBytes } from '../store-projections.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync, syncOneShot } from '../sync.ts'
import { collectWorkspaceScan, makeTempWorkspace, testPageId } from '../testing/filesystem.ts'
import {
  defaultQueryContract,
  decode,
  fixedObservedAt,
  hash,
  localDeleteIntent,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  propertyPatchValue,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-realistic')
const bodyPath = decode(WorkspaceRelativePath, 'row--page-1.nmd')

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: testIds.propertyB,
    configHash: hash('config-b'),
    writeClass: 'writable' as const,
  },
]

const implementedRealisticWorkflowScenarioIds = new Set<ScenarioId>([
  'NDS-L4-realistic-initial-materialization',
  'NDS-L3-realistic-remote-drift-local-write',
  'NDS-L3-realistic-local-remote-conflict',
  'NDS-L3-realistic-schema-capability-failure',
  'NDS-L4-realistic-filesystem-delete-repair',
])

const propertyPage = ({
  pageId = testIds.pageId,
  propertyId = testIds.propertyA,
  valueHash = propertyId === testIds.propertyB ? hash('property-b-base') : hash('property-a-base'),
}: {
  readonly pageId?: PageIdType
  readonly propertyId?: PropertyIdType
  readonly valueHash?: HashType
} = {}) =>
  decode(PagePropertyItemPage, {
    _tag: 'PagePropertyItemPage',
    apiVersion: '2026-03-11',
    requestId: testIds.requestId,
    pageId,
    propertyId,
    items: [
      {
        _tag: 'PagePropertyItem',
        pageId,
        propertyId,
        itemHash: valueHash,
        valueHash,
      },
    ],
    nextCursor: null,
    hasMore: false,
  })

const propertyPages = ({
  propertyA = hash('property-a-base'),
  propertyB = hash('property-b-base'),
}: {
  readonly propertyA?: HashType
  readonly propertyB?: HashType
} = {}) => [
  propertyPage({ propertyId: testIds.propertyA, valueHash: propertyA }),
  propertyPage({ propertyId: testIds.propertyB, valueHash: propertyB }),
]

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: NotionDataSourceGatewayShape
    readonly body?: PageBodySyncPortShape
    readonly workspace?: LocalWorkspacePortShape
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body ?? makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, input.workspace ?? makeHarnessPorts().workspace),
    ),
  )

const initializedStore = ({
  workspace = workspaceRoot,
}: {
  readonly workspace?: typeof AbsolutePath.Type
} = {}) => {
  const clock = makeFakeClock()
  const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
  initOneShotSync({
    store: storeFixture.store,
    rootId: testIds.rootId,
    dataSourceId: testIds.dataSourceId,
    workspaceRoot: workspace,
    now: clock.now,
  })

  return { clock, storeFixture }
}

const pullOptions = ({
  store,
  clock,
  workspace = workspaceRoot,
}: {
  readonly store: ReturnType<typeof makeStoreFixture>['store']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly workspace?: typeof AbsolutePath.Type
}) => ({
  store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: workspace,
  queryContract: defaultQueryContract(),
  schemaProperties,
  now: clock.now,
})

const expectedPatchHash = () =>
  hashStoreBytes(`page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`)

const runNodeFileSystem = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const removeFile = (path: string) =>
  runNodeFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path)
    }),
  )

const writeFileString = (path: string, content: string) =>
  runNodeFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(path, content)
    }),
  )

const propertyCommand = (basePropertiesHash: HashType) =>
  decode(PatchPagePropertiesCommand, {
    _tag: 'PatchPagePropertiesCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash,
    propertyPatch: {
      [testIds.propertyA]: propertyPatchValue('Local edit'),
    },
  })

describe('realistic offline workflow E2E matrix', () => {
  it('keeps realistic workflow scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/realistic-workflows.e2e.test.ts',
        implementedScenarioIds: implementedRealisticWorkflowScenarioIds,
      }),
    ).toEqual([])
  })

  it('materializes an initial pull and proves a second full sync is idempotent', async () => {
    const fixture = await makeTempWorkspace()
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: propertyPages() })
    const ports = makeHarnessPorts()
    const options = pullOptions({ store: storeFixture.store, clock, workspace: fixture.root })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: fixture.root,
        now: clock.now,
      })

      const first = await runWithPorts(syncOneShot(options), {
        gateway: gatewayHarness.gateway,
        body: ports.body,
        workspace,
      })
      const scan = await collectWorkspaceScan(workspace, fixture.root)
      const eventCount = storeFixture.store.replay(testIds.rootId).length
      const digest = storeFixture.store.computeCurrentProjectionDigest(testIds.rootId)
      const metadata = storeFixture.store.readProjectionMetadata(testIds.rootId)

      storeFixture.store.clearProjectionTables()
      const rebuilt = storeFixture.store.rebuildProjections(testIds.rootId)
      const second = await runWithPorts(syncOneShot(options), {
        gateway: gatewayHarness.gateway,
        body: ports.body,
        workspace,
      })

      expect(first.status).toMatchObject({
        state: 'clean',
        counts: {
          projections: { dataSources: 1, rows: 1, properties: 2, bodies: 1 },
        },
      })
      expect(scan).toEqual([
        expect.objectContaining({
          pageId: testIds.pageId,
          contentHash: hash('body-a'),
          state: 'present',
        }),
      ])
      expect(metadata?.digest).toBe(digest)
      expect(rebuilt.digest).toBe(digest)
      expect(second.pull.appendedEvents).toBe(0)
      expect(second.push.plan).toMatchObject({
        appendedEvents: 0,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 0,
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(eventCount)
      expect(gatewayHarness.ledger).toMatchObject({
        attemptedPatchPageProperties: [],
        attemptedTrashPages: [],
      })
    } finally {
      storeFixture.cleanup()
      await fixture.cleanup()
    }
  })

  it('applies remote disjoint drift locally before planning and settling a local property write', async () => {
    const { clock, storeFixture } = initializedStore()
    const baseGateway = makeFakeGatewayHarness({ propertyPages: propertyPages() })
    const remotePropertiesHash = hash('properties-with-remote-b')
    const remoteGateway = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: remotePropertiesHash })],
      propertyPages: propertyPages({ propertyB: hash('property-b-remote') }),
    })
    const command = propertyCommand(remotePropertiesHash)

    try {
      await runWithPorts(pullOneShotSync(pullOptions({ store: storeFixture.store, clock })), {
        gateway: baseGateway.gateway,
      })
      clock.advanceMillis(1)
      const remoteDrift = await runWithPorts(
        pullOneShotSync(pullOptions({ store: storeFixture.store, clock })),
        { gateway: remoteGateway.gateway },
      )
      const projected = storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId)

      expect(remoteDrift.status.state).toBe('clean')
      expect(projected.properties).toContainEqual(
        expect.objectContaining({
          propertyId: testIds.propertyB,
          remoteHash: hash('property-b-remote'),
          pendingLocal: undefined,
        }),
      )

      const push = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [
            propertyEditIntent({
              command,
              desiredHash: expectedPatchHash(),
              expectedPropertyConfigHash: hash('config-a'),
            }),
          ],
          now: clock.now,
        }),
        { gateway: remoteGateway.gateway },
      )

      expect(push.plan).toMatchObject({ enqueuedCommands: 1, blocked: 0, conflicts: 0 })
      expect(push.executor.results).toContainEqual(
        expect.objectContaining({
          _tag: 'settled',
          settlementKind: 'verified-success',
        }),
      )
      expect(remoteGateway.ledger.successfulPatchPageProperties).toEqual([command])
      expect(push.status.state).toBe('clean')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps a pending local property intent while remote same-property drift becomes a durable conflict', async () => {
    const { clock, storeFixture } = initializedStore()
    const baseGateway = makeFakeGatewayHarness({ propertyPages: propertyPages() })
    const remoteGateway = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: hash('properties-remote-a') })],
      propertyPages: propertyPages({ propertyA: hash('property-a-remote') }),
    })
    const localIntent = propertyEditIntent({
      desiredHash: expectedPatchHash(),
      expectedPropertyConfigHash: hash('config-a'),
    })

    try {
      await runWithPorts(pullOneShotSync(pullOptions({ store: storeFixture.store, clock })), {
        gateway: baseGateway.gateway,
      })

      const queued = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [localIntent],
          maxExecutorSteps: 0,
          now: clock.now,
        }),
        { gateway: baseGateway.gateway },
      )
      expect(queued.status.state).toBe('pending')
      expect(
        storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).properties,
      ).toContainEqual(
        expect.objectContaining({
          propertyId: testIds.propertyA,
          pendingLocal: {
            intentEventId: testIds.intentEventId,
            targetHash: expectedPatchHash(),
          },
        }),
      )

      clock.advanceMillis(1)
      await runWithPorts(pullOneShotSync(pullOptions({ store: storeFixture.store, clock })), {
        gateway: remoteGateway.gateway,
      })
      const afterRemote = storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId)
      expect(afterRemote.properties).toContainEqual(
        expect.objectContaining({
          propertyId: testIds.propertyA,
          remoteHash: hash('property-a-remote'),
          pendingLocal: {
            intentEventId: testIds.intentEventId,
            targetHash: expectedPatchHash(),
          },
        }),
      )

      const conflict = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [localIntent],
          maxExecutorSteps: 0,
          now: clock.now,
        }),
        { gateway: remoteGateway.gateway },
      )

      expect(conflict.plan).toMatchObject({
        enqueuedCommands: 0,
        conflicts: 1,
      })
      expect(remoteGateway.ledger.attemptedPatchPageProperties).toEqual([])
      expect(storeFixture.store.readConflicts(testIds.rootId)).toEqual([
        expect.objectContaining({
          state: 'open',
          kind: 'same-property',
          localHash: expectedPatchHash(),
          remoteHash: hash('property-a-remote'),
        }),
      ])

      storeFixture.store.clearProjectionTables()
      storeFixture.store.rebuildProjections(testIds.rootId)
      expect(storeFixture.store.readConflicts(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'open', kind: 'same-property' }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('fails closed for missing capabilities and schema drift before remote mutation', async () => {
    const { clock, storeFixture } = initializedStore()
    let propertyPaginationCalls = 0
    const missingCapabilityHarness = makeFakeGatewayHarness({
      capabilities: allGatewayCapabilities.filter(
        (capability) => capability !== 'page_property_paginate',
      ),
      propertyPages: propertyPages(),
    })
    const missingCapabilityGateway = {
      ...missingCapabilityHarness.gateway,
      retrievePageProperty: (
        input: Parameters<typeof missingCapabilityHarness.gateway.retrievePageProperty>[0],
      ) => {
        propertyPaginationCalls += 1
        return missingCapabilityHarness.gateway.retrievePageProperty(input)
      },
    }
    const recoveredGateway = makeFakeGatewayHarness({ propertyPages: propertyPages() })

    try {
      const blocked = await runWithPorts(
        pullOneShotSync(pullOptions({ store: storeFixture.store, clock })),
        { gateway: missingCapabilityGateway },
      )

      expect(blocked.status).toMatchObject({
        state: 'blocked',
        counts: { capabilities: { unsupported: 1 } },
      })
      expect(propertyPaginationCalls).toBe(0)

      clock.advanceMillis(1)
      await runWithPorts(pullOneShotSync(pullOptions({ store: storeFixture.store, clock })), {
        gateway: recoveredGateway.gateway,
      })
      const schemaDrift = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [
            propertyEditIntent({
              expectedPropertyConfigHash: hash('stale-config'),
            }),
          ],
          now: clock.now,
        }),
        { gateway: recoveredGateway.gateway },
      )

      expect(schemaDrift.plan).toMatchObject({
        enqueuedCommands: 0,
        blocked: 1,
        conflicts: 0,
      })
      expect(schemaDrift.plan.decisions).toEqual([
        expect.objectContaining({
          _tag: 'BlockedByGuard',
          guard: 'SchemaDriftAffectsIntent',
        }),
      ])
      expect(recoveredGateway.ledger.attemptedPatchPageProperties).toEqual([])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps local delete candidate-only and handles filesystem damage and repair locally', async () => {
    const { clock, storeFixture } = initializedStore()
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: propertyPages() })

    try {
      await runWithPorts(pullOneShotSync(pullOptions({ store: storeFixture.store, clock })), {
        gateway: gatewayHarness.gateway,
      })

      const candidate = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          now: clock.now,
        }),
        {
          gateway: gatewayHarness.gateway,
          workspace: makeHarnessPorts({
            localObservations: [
              {
                _tag: 'LocalArtifactObservation',
                pageId: testIds.pageId,
                path: bodyPath,
                contentHash: hash('body-a'),
                observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
                state: 'delete-candidate',
              },
            ],
          }).workspace,
        },
      )

      expect(candidate.plan.decisions).toEqual([
        {
          _tag: 'AppendEvents',
          events: [
            {
              _tag: 'LocalDeleteCandidateAccepted',
              pageId: testIds.pageId,
              surface: `page:${testIds.pageId}`,
              reason: 'filesystem-delete-candidate',
            },
          ],
        },
      ])
      expect(candidate.plan).toMatchObject({ enqueuedCommands: 0, conflicts: 0 })
      expect(gatewayHarness.ledger.attemptedTrashPages).toEqual([])

      const trash = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [
            localDeleteIntent({
              explicitDestructiveIntent: true,
              policy: 'trustedRemoteTrash',
            }),
          ],
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(trash.executor.results).toContainEqual(
        expect.objectContaining({
          _tag: 'settled',
          settlementKind: 'verified-success',
        }),
      )
      expect(gatewayHarness.ledger.successfulTrashPages).toHaveLength(1)
    } finally {
      storeFixture.cleanup()
    }

    const fixture = await makeTempWorkspace()
    try {
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const pageId = testIds.pageId
      const otherPageId = testPageId('page-2')
      const path = decode(WorkspaceRelativePath, 'weekly-notes--page-1.nmd')
      const collisionPath = decode(WorkspaceRelativePath, 'shared--page.nmd')

      await expect(
        Effect.runPromise(
          workspace.claimPath({ _tag: 'PathClaimPlan', pageId, path: collisionPath }),
        ),
      ).resolves.toEqual({ _tag: 'claimed', pageId, path: collisionPath })
      await expect(
        Effect.runPromise(
          workspace.claimPath({ _tag: 'PathClaimPlan', pageId: otherPageId, path: collisionPath }),
        ),
      ).resolves.toEqual({
        _tag: 'conflict',
        pageId: otherPageId,
        requestedPath: collisionPath,
        existingPageId: pageId,
      })
      expect(canonicalizeWorkspaceRelativePath({ path: '../escape.nmd' })).toMatchObject({
        _tag: 'blocked',
        guard: 'PathEscapesRoot',
      })
      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.claimPath({
              _tag: 'PathClaimPlan',
              pageId,
              path: decode(WorkspaceRelativePath, '../escape.nmd'),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'claimPath',
      })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: decode(BodyPointer, {
            _tag: 'BodyPointer',
            pageId,
            bodyHash: hash('body-a'),
            observedAt: fixedObservedAt,
          }),
        }),
      )
      await removeFile(join(fixture.root, path))
      await expect(collectWorkspaceScan(workspace, fixture.root)).resolves.toEqual([
        expect.objectContaining({
          pageId,
          path,
          contentHash: hash('body-a'),
          state: 'delete-candidate',
        }),
      ])
      await expect(
        Effect.runPromise(
          workspace.materialize({
            _tag: 'MaterializePlan',
            pageId,
            path,
            bodyPointer: decode(BodyPointer, {
              _tag: 'BodyPointer',
              pageId,
              bodyHash: hash('body-b'),
              observedAt: fixedObservedAt,
            }),
          }),
        ),
      ).resolves.toMatchObject({ _tag: 'MaterializeResult', pageId, bodyHash: hash('body-b') })
      await writeFileString(
        filesystemWorkspacePageSidecarPath({ root: fixture.root, pageId }),
        '{ damaged',
      )
      await expect(collectWorkspaceScan(workspace, fixture.root)).rejects.toThrow(
        'Workspace page sidecar is damaged',
      )
    } finally {
      await fixture.cleanup()
    }
  })
})
