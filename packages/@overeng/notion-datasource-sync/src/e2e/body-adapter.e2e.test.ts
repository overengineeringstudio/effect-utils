import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NmdStateStore,
  NmdStateStoreLive,
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
  Hash,
  WorkspaceRelativePath,
  type BodySafetySnapshot,
} from '../core/domain.ts'
import { BodySyncError } from '../core/errors.ts'
import { RowObserved } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { makeFakeLocalWorkspacePort, presentArtifactObservation } from '../local/workspace.ts'
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
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-body-adapter' })
const bodyPath = decode({ schema: WorkspaceRelativePath, value: 'page-1.nmd' })
const contentHash = (content: string) =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(content).digest('hex')}` })
const implementedBodyAdapterScenarioIds = new Set<ScenarioId>([
  'NDS-L2-body-adapter-fail-closed-boundary',
  'NDS-L6-bidi-body-local-capture-first',
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
    effect.pipe(Effect.provide(NmdStateStoreLive), Effect.provide(NodeContext.layer)),
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
        bodyPointer: {
          _tag: 'BodyPointer',
          pageId: testIds.pageId,
          bodyHash: hash('body-a'),
          observedAt: '2026-05-25T00:00:00.000Z',
          safety,
        },
        inTrash: false,
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
      appendPlannedCommand({
        store: storeFixture.store,
        command: {
          rootId: testIds.rootId,
          commandId: testIds.commandId,
          commandKey: testIds.commandKey,
          intentEventId: testIds.intentEventId,
          surface: bodySurfaceKey(testIds.pageId),
          command,
          baseHash: baseBodyPointer.bodyHash,
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
      listChildPages: () => Effect.succeed([]),
    }

    try {
      const stateStore = await runWithNmdStateStore(NmdStateStore)
      const body = makeNotionMdPageBodySyncPort({ gateway: notionMdGateway })
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
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot: root,
          now: makeFakeClock().now,
        }),
        {
          gateway: gatewayHarness.gateway,
          body,
          workspace,
        },
      )

      expect(result.localObservations).toBe(1)
      expect(result.plan.enqueuedCommands).toBe(1)
      expect(result.executor.results).toEqual([
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
