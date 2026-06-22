import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyEvidenceFingerprintSchema as NotionMdBodyEvidenceFingerprint,
  NOTION_API_VERSION,
} from '@overeng/notion-effect-client'
import {
  NotionMdGateway,
  NmdStateStore,
  NmdStateStoreLive,
  statusFile,
  type NotionMdGatewayShape,
  type PullPageResult,
} from '@overeng/notion-md'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import {
  makeNotionMdMaterializingLocalWorkspacePort,
  makeNotionMdPageBodySyncPort,
} from '../body/notion-md.ts'
import { bodySurfaceKey } from '../core/canonical.ts'
import type { BodyPushCommand as BodyPushCommandType } from '../core/commands.ts'
import {
  AbsolutePath,
  BodyPointer,
  Hash,
  bodyEvidenceFingerprintFromContentDigest,
  bodyPointerIdentityDigest,
  renderedBodyDigest,
  evidenceBackedBodyIdentity,
  WorkspaceRelativePath,
  type BodySafetySnapshot,
} from '../core/domain.ts'
import { BodySyncError } from '../core/errors.ts'
import { RowObserved, SyncEvent, SyncEventId } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { makeFakeLocalWorkspacePort, presentArtifactObservation } from '../local/workspace.ts'
import { resolveConflictCommand } from '../planner/user-commands.ts'
import { executeOutboxOnce } from '../sync/executor.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync, syncOneShot } from '../sync/sync.ts'
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
  propertyPatchValue,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-body-adapter' })
const bodyPath = decode({ schema: WorkspaceRelativePath, value: 'page-1.nmd' })
const contentHash = (content: string) =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(content).digest('hex')}` })
const notionMdBodyEvidenceFingerprint = Schema.decodeUnknownSync(NotionMdBodyEvidenceFingerprint)
const implementedBodyAdapterScenarioIds = new Set<ScenarioId>([
  'NDS-L2-body-adapter-fail-closed-boundary',
  'NDS-L6-bidi-body-local-capture-first',
  // L7 downstream composition: the 'materializes, pushes, and verifies a
  // NotionMD-backed local body edit' test drives the standalone @overeng/notion-md
  // body adapter over the real package boundary.
  'NDS-L7-datasource-workspace-consumes-standalone-nmd',
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

const pullPageResult = (markdown: string): PullPageResult => ({
  page: {
    id: testIds.pageId,
    title: 'Page 1',
    title_property_key: 'Name',
    url: undefined,
    parent: { type: 'workspace', workspace: true },
    icon: null,
    cover: null,
    in_trash: false,
    is_locked: false,
    last_edited_time: '2026-05-25T00:00:00.000Z',
    properties: {},
  },
  markdown: {
    markdown,
    truncated: false,
    unknown_block_ids: [],
    body_evidence_fingerprint: notionMdBodyEvidenceFingerprint(contentHash(markdown)),
  },
  storage: {
    _tag: 'self_contained',
    unsupported_blocks: [],
    files: [],
    comments: [],
  },
})

const runWithNmdStateStore = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, NmdStateStore>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)))),
  )

const assertNoGatewayMutations = (ledger: ReturnType<typeof makeFakeGatewayHarness>['ledger']) => {
  expect(ledger.attemptedPatchPageProperties).toEqual([])
  expect(ledger.attemptedPatchDataSourceSchemas).toEqual([])
  expect(ledger.attemptedTrashPages).toEqual([])
  expect(ledger.attemptedRestorePages).toEqual([])
}

const appendObservedBodyProjection = (
  store: ReturnType<typeof makeStoreFixture>['store'],
  safety: BodySafetySnapshot,
  pointer = bodyPointer(hash('body-a')),
) => {
  store.appendEvent(
    decode({
      schema: RowObserved,
      value: {
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
        bodyPointer: Schema.encodeSync(BodyPointer)({
          ...pointer,
          safety,
        }),
        inTrash: false,
      },
    }),
  )
}

const appendPlannerPreflightEvidence = (store: ReturnType<typeof makeStoreFixture>['store']) => {
  store.appendEvent(
    decode({
      schema: SyncEvent,
      value: {
        _tag: 'ApiContractObserved',
        eventId: 'body-adapter-api-contract',
        rootId: testIds.rootId,
        sequence: '0',
        codecVersion: 'v1',
        family: 'CompatibilityChecked',
        eventType: 'ApiContractObserved',
        idempotencyKey: 'body-adapter-api-contract',
        surface: null,
        causedByEventIds: [],
        payloadHash: hash('body-adapter-api-contract'),
        payload: {
          _tag: 'VersionedJson',
          codecVersion: 'v1',
          canonicalJson: '{"api":true}',
        },
        observedAt: '2026-05-25T00:00:00.000Z',
        apiContract: {
          _tag: 'NotionApiContract',
          apiVersion: NOTION_API_VERSION,
          clientVersion: 'test-client',
          supportedCapabilities: ['page_property_update'],
        },
      },
    }),
  )
  store.appendEvent(
    decode({
      schema: SyncEvent,
      value: {
        _tag: 'CapabilityPreflightChecked',
        eventId: 'body-adapter-capability',
        rootId: testIds.rootId,
        sequence: '0',
        codecVersion: 'v1',
        family: 'CompatibilityChecked',
        eventType: 'CapabilityPreflightChecked',
        idempotencyKey: 'body-adapter-capability',
        surface: `data-source:${testIds.dataSourceId}`,
        causedByEventIds: [],
        payloadHash: hash('body-adapter-capability'),
        payload: {
          _tag: 'VersionedJson',
          codecVersion: 'v1',
          canonicalJson: '{"capability":"page_property_update"}',
        },
        observedAt: '2026-05-25T00:00:00.000Z',
        dataSourceId: testIds.dataSourceId,
        capability: 'page_property_update',
        supported: true,
        requestId: testIds.requestId,
      },
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

  it('captures local .nmd edits before established sync can materialize remote bodies', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const baseBodyPort = makeHarnessPorts().body
    const { body } = bodyPortWithPushLedger(baseBodyPort)
    const baseWorkspace = makeFakeLocalWorkspacePort({
      observations: [
        presentArtifactObservation({
          pageId: testIds.pageId,
          path: bodyPath,
          contentHash: hash('body-local-edit'),
          bodyContent: '# Local edit',
          observedAt: bodyPointer().observedAt,
        }),
      ],
    })
    const calls: string[] = []
    const workspace: LocalWorkspacePortShape = {
      ...baseWorkspace,
      scan: (root) => {
        calls.push('scan')
        return baseWorkspace.scan(root)
      },
      materialize: (plan) =>
        Effect.sync(() => {
          calls.push('materialize')
          return plan
        }).pipe(Effect.zipRight(baseWorkspace.materialize(plan))),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: makeFakeClock().now,
      })
      appendObservedBodyProjection(storeFixture.store, bodySafety())

      const result = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: makeFakeClock().now,
        }),
        {
          gateway: gatewayHarness.gateway,
          body,
          workspace,
        },
      )

      expect(calls).toEqual(['scan'])
      expect(
        result.push.plan.enqueuedCommands + result.push.plan.conflicts + result.push.plan.blocked,
      ).toBeGreaterThan(0)
      assertNoGatewayMutations(gatewayHarness.ledger)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('plans local body edits against evidence-backed pointer identity', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const renderedHash = hash('body-a')
    const evidenceHash = hash('body-evidence')
    const renderedPointer = bodyPointer(renderedHash)
    const basePointer = {
      ...renderedPointer,
      identity: evidenceBackedBodyIdentity({
        rendered: renderedPointer.identity.rendered,
        evidenceFingerprint: bodyEvidenceFingerprintFromContentDigest(evidenceHash),
        completeness: 'complete',
      }),
    }
    const baseWorkspace = makeFakeLocalWorkspacePort()

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: makeFakeClock().now,
      })
      appendPlannerPreflightEvidence(storeFixture.store)
      appendObservedBodyProjection(storeFixture.store, bodySafety(), basePointer)
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).bodies).toMatchObject(
        [
          {
            pageId: testIds.pageId,
            currentHash: bodyPointerIdentityDigest(basePointer),
          },
        ],
      )

      const result = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          now: makeFakeClock().now,
          maxExecutorSteps: 0,
          localWorkspaceObservation: {
            observations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: bodyPath,
                contentHash: hash('body-local-edit'),
                bodyContent: '# Local edit',
                observedAt: basePointer.observedAt,
              }),
            ],
          },
        }),
        {
          gateway: gatewayHarness.gateway,
          body: makeHarnessPorts({ bodyPages: [fakeBodyPage({ pointer: basePointer })] }).body,
          workspace: baseWorkspace,
        },
      )

      expect(result.plan.decisions).toEqual([
        expect.objectContaining({
          _tag: 'EnqueueCommands',
        }),
      ])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandTag: 'BodyPush',
          baseHash: bodyPointerIdentityDigest(basePointer),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
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

  // Decision 0013: a reachable adapter `body` conflict (a real remote-vs-local body
  // divergence from `planLocalChange` → `BodyConflict`) IS resolvable. Body is
  // single-surface and adapter-owned, so resolution is re-push (keep-local) /
  // re-materialize (keep-remote), NOT a value merge. These tests raise the conflict
  // through the real push path, then resolve it both ways.
  describe('body conflict resolution (decision 0021)', () => {
    // Raise a reachable adapter `body` conflict and return the store fixture + the
    // open conflict id. A genuine remote-vs-local body divergence: the remote body
    // identity (`body-remote`) differs from the observed local base (`body-a`), so
    // `planLocalChange` returns a `BodyConflict` with reason `StaleSurfaceBase` and
    // CLEAN safety — the keep-local re-push is therefore not blocked by a safety
    // guard, only gated on the (matching) current base.
    const raiseBodyConflict = async () => {
      const storeFixture = makeStoreFixture({ mode: 'memory' })
      const gatewayHarness = makeFakeGatewayHarness()
      const safety = bodySafety()
      const bodyPort = makeHarnessPorts({
        bodyPages: [fakeBodyPage({ safety, pointer: bodyPointer(hash('body-remote')) })],
      }).body
      const { body: trackedBody, pushed } = bodyPortWithPushLedger(bodyPort)

      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: makeFakeClock().now,
      })
      appendObservedBodyProjection(storeFixture.store, safety)
      // Planner preflight evidence so the keep-local re-push clears the API/capability
      // guards and reaches `EnqueueCommands` (the conflict raise itself does not need it).
      appendPlannerPreflightEvidence(storeFixture.store)

      await runWithPorts(
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

      const conflict = storeFixture.store
        .readConflicts(testIds.rootId)
        .find((row) => row.kind === 'body' && row.state === 'open')
      expect(conflict).toMatchObject({
        kind: 'body',
        pageId: testIds.pageId,
        propertyId: undefined,
      })
      return {
        storeFixture,
        gatewayHarness,
        bodyPort,
        pushed,
        conflictId: decode({ schema: SyncEventId, value: conflict!.conflictId }),
      }
    }

    it('keep-local re-enqueues a BodyPushCommand re-asserting the local .nmd body', async () => {
      const { storeFixture, conflictId } = await raiseBodyConflict()
      try {
        const resolved = resolveConflictCommand({
          store: storeFixture.store,
          rootId: testIds.rootId,
          conflictId,
          choice: { _tag: 'keep-local', value: propertyPatchValue() },
          now: makeFakeClock().now,
        })

        // A re-push command is enqueued and the resolution is recorded.
        expect(resolved.applied.events).toMatchObject([
          { _tag: 'ConflictResolved', resolutionChoice: 'keep-local' },
        ])
        expect(resolved.applied.commands).toMatchObject([
          { command: { _tag: 'BodyPushCommand', pageId: testIds.pageId } },
        ])
        const outbox = storeFixture.store.readOutbox(testIds.rootId)
        expect(outbox).toMatchObject([
          { commandTag: 'BodyPush', surface: bodySurfaceKey(testIds.pageId) },
        ])
        expect(storeFixture.store.readConflicts(testIds.rootId)).toMatchObject([
          { kind: 'body', state: 'resolved' },
        ])
      } finally {
        storeFixture.cleanup()
      }
    })

    it('keep-remote re-materializes (resets sidecar identity) and clears the conflict', async () => {
      const { storeFixture, gatewayHarness, bodyPort, conflictId } = await raiseBodyConflict()
      try {
        // Before resolution the body sidecar identity is proven (the materialized
        // pull matched the local sidecar).
        expect(
          storeFixture.store
            .readPlannerProjectionSnapshot(testIds.rootId)
            .bodies.find((body) => body.pageId === testIds.pageId)?.sidecarIdentityProven,
        ).toBe(true)

        const resolved = resolveConflictCommand({
          store: storeFixture.store,
          rootId: testIds.rootId,
          conflictId,
          choice: { _tag: 'keep-remote' },
          now: makeFakeClock().now,
        })

        // No push: keep-remote accepts the remote body. The conflict clears and the
        // re-materialization intent is recorded (sidecar identity reset → the next
        // pull rewrites the `.nmd` from the remote observation).
        expect(resolved.applied.events).toMatchObject([
          { _tag: 'ConflictResolved', resolutionChoice: 'keep-remote' },
        ])
        expect(resolved.applied.commands).toEqual([])
        expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])
        expect(storeFixture.store.readConflicts(testIds.rootId)).toMatchObject([
          { kind: 'body', state: 'resolved' },
        ])
        expect(
          storeFixture.store
            .readPlannerProjectionSnapshot(testIds.rootId)
            .bodies.find((body) => body.pageId === testIds.pageId)?.sidecarIdentityProven,
        ).toBe(false)

        // PROOF the intent is CONSUMED: a pull with the mirror's global
        // `materializeBodyArtifacts: false` suppression STILL re-materializes this
        // page, because its cleared `sidecarIdentityProven` forces it through the
        // per-page override. Without keep-remote (sidecar still proven) the
        // suppression would skip materialization entirely.
        const { workspace, materializeCalls } = trackedWorkspace()
        await runWithPorts(
          pullOneShotSync({
            ...pullOptions(storeFixture.store),
            materializeBodyArtifacts: false,
          }),
          { gateway: gatewayHarness.gateway, body: bodyPort, workspace },
        )
        expect(materializeCalls()).toBe(1)
        expect(
          storeFixture.store
            .readPlannerProjectionSnapshot(testIds.rootId)
            .bodies.find((body) => body.pageId === testIds.pageId)?.sidecarIdentityProven,
        ).toBe(true)
      } finally {
        storeFixture.cleanup()
      }
    })

    it.each([
      ['keep-local', { _tag: 'keep-local', value: propertyPatchValue() }],
      ['keep-remote', { _tag: 'keep-remote' }],
    ] as const)(
      'replay determinism: %s body resolution survives a projection rebuild',
      async (_name, choice) => {
        const { storeFixture, conflictId } = await raiseBodyConflict()
        try {
          resolveConflictCommand({
            store: storeFixture.store,
            rootId: testIds.rootId,
            conflictId,
            choice,
            now: makeFakeClock().now,
          })
          const before = storeFixture.store.readConflicts(testIds.rootId)

          storeFixture.store.clearProjectionTables()
          storeFixture.store.rebuildProjections(testIds.rootId)

          expect(storeFixture.store.readConflicts(testIds.rootId)).toEqual(before)
          expect(storeFixture.store.readConflicts(testIds.rootId)).toMatchObject([
            { kind: 'body', state: 'resolved' },
          ])
        } finally {
          storeFixture.cleanup()
        }
      },
    )
  })

  // Decision 0013 (adapter-authoritative): body is single-surface and adapter-owned;
  // it is NOT routed through the convergence engine. The adapter (`planLocalChange`)
  // is the sole body authority and must fire and conflict on a stale/lossy remote
  // even in `shared` mode (where the property convergence engine runs for properties).
  it('ADAPTER-AUTHORITATIVE: an edited body blocks via the adapter on a lossy remote (shared mode)', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const safety = bodySafety({ truncated: true })
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

      const result = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          // `shared` mode runs the property convergence engine; the body path stays
          // adapter-owned and must not be short-circuited by it.
          authorityMode: 'shared',
          now: makeFakeClock().now,
          localWorkspaceObservation: {
            observations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: bodyPath,
                contentHash: hash('body-local-edit'),
                observedAt: bodyPointer().observedAt,
              }),
            ],
          },
        }),
        {
          gateway: gatewayHarness.gateway,
          body: trackedBody,
          workspace: makeFakeLocalWorkspacePort(),
        },
      )

      const conflicts = storeFixture.store
        .replay(testIds.rootId)
        .filter((event) => event._tag === 'ConflictRaised')

      // The adapter `body` conflict stops the push (body is adapter-owned).
      expect(result.plan).toMatchObject({ enqueuedCommands: 0, conflicts: 1 })
      expect(pushed).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])
      expect(conflicts.at(-1)).toMatchObject({
        _tag: 'ConflictRaised',
        conflictKind: 'body',
        pageId: testIds.pageId,
      })
      assertNoGatewayMutations(gatewayHarness.ledger)
    } finally {
      storeFixture.cleanup()
    }
  })

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
      appendPlannedCommand({
        store: storeFixture.store,
        command: {
          rootId: testIds.rootId,
          commandId: testIds.commandId,
          commandKey: testIds.commandKey,
          intentEventId: testIds.intentEventId,
          surface: bodySurfaceKey(testIds.pageId),
          command,
          baseHash: renderedBodyDigest(baseBodyPointer.identity),
          desiredHash: hash('body-next'),
          preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'BodyAdapterConflict'],
        },
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

  it('materializes, pushes, and verifies a NotionMD-backed local body edit', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'notion-ds-sync-body-adapter-'))
    const root = decode({ schema: AbsolutePath, value: rootPath })
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    const gatewayHarness = makeFakeGatewayHarness()
    const updates: Parameters<NotionMdGatewayShape['updateMarkdown']>[0][] = []
    let remoteMarkdown = '# Page 1\n\nRemote body.\n'
    const notionMdGateway: NotionMdGatewayShape = {
      pullPage: () => Effect.succeed(pullPageResult(remoteMarkdown)),
      updateMarkdown: (opts) =>
        Effect.sync(() => {
          updates.push(opts)
          remoteMarkdown =
            opts.command._tag === 'replace_content'
              ? opts.command.markdown
              : opts.command.contentUpdates.reduce(
                  (markdown, update) => markdown.replaceAll(update.oldStr, update.newStr),
                  remoteMarkdown,
                )
          return pullPageResult(remoteMarkdown)
        }),
      updatePageProperties: () =>
        Effect.die('updatePageProperties should not be called by this test'),
      updatePageMetadata: () => Effect.die('updatePageMetadata should not be called by this test'),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called by this test'),
      listChildPages: () => Effect.succeed([]),
      createPage: () => Effect.die('createPage should not be called by this test'),
      movePage: () => Effect.die('movePage should not be called by this test'),
      archivePage: () => Effect.die('archivePage should not be called by this test'),
    }

    try {
      const stateStore = await runWithNmdStateStore(NmdStateStore)
      const body = makeNotionMdPageBodySyncPort({
        root,
        gateway: notionMdGateway,
        stateStore,
      })
      const workspace = makeNotionMdMaterializingLocalWorkspacePort({
        root,
        gateway: notionMdGateway,
        stateStore,
      })

      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: root,
        now: makeFakeClock().now,
      })

      await runWithPorts(
        pullOneShotSync({
          ...pullOptions(storeFixture.store),
          workspaceRoot: root,
          bodyPathForPage: () => bodyPath,
        }),
        {
          gateway: gatewayHarness.gateway,
          body,
          workspace,
        },
      )

      const absoluteBodyPath = join(rootPath, bodyPath)
      const materialized = await readFile(absoluteBodyPath, 'utf8')
      const localMarkdown = '# Page 1\n\nLocal body pushed through NotionMD.\n'
      await writeFile(
        absoluteBodyPath,
        materialized.replace('Remote body.', 'Local body pushed through NotionMD.'),
        'utf8',
      )

      const result = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: root,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: makeFakeClock().now,
        }),
        {
          gateway: gatewayHarness.gateway,
          body,
          workspace,
        },
      )

      expect(result.push.localObservations).toBe(1)
      expect(result.push.plan.enqueuedCommands).toBe(1)
      expect(result.push.executor.results).toEqual([
        {
          _tag: 'settled',
          commandId: expect.any(String),
          settlementKind: 'verified-success',
        },
        {
          _tag: 'idle',
        },
      ])
      expect(updates).toEqual([
        {
          pageId: testIds.pageId,
          command: {
            _tag: 'replace_content',
            markdown: localMarkdown,
          },
          allowDeletingContent: false,
        },
      ])
      expect(remoteMarkdown).toBe(localMarkdown)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandTag: 'BodyPush',
          state: 'settled',
          desiredHash: contentHash(localMarkdown),
        },
      ])
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).bodies).toMatchObject(
        [
          {
            pageId: testIds.pageId,
            baseHash: contentHash(localMarkdown),
            currentHash: contentHash(localMarkdown),
          },
        ],
      )
      expect(result.status).toMatchObject({
        state: 'clean',
        counts: {
          conflict: 0,
          outbox: { queued: 0, running: 0, retryable: 0 },
        },
      })
      const nmdStatus = await Effect.runPromise(
        statusFile({ path: absoluteBodyPath }).pipe(
          Effect.provideService(NotionMdGateway, notionMdGateway),
          Effect.provideService(NmdStateStore, stateStore),
          Effect.provide(NodeContext.layer),
        ),
      )
      expect(nmdStatus.status).toBe('in-sync')

      const second = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: root,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: makeFakeClock().now,
        }),
        {
          gateway: gatewayHarness.gateway,
          body,
          workspace,
        },
      )

      expect(second.push.plan.enqueuedCommands).toBe(0)
      expect(second.push.executor.results).toEqual([{ _tag: 'idle' }])
      expect(second.status.state).toBe('clean')
      expect(updates).toHaveLength(1)
      assertNoGatewayMutations(gatewayHarness.ledger)
    } finally {
      storeFixture.cleanup()
      await rm(rootPath, { recursive: true, force: true })
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
