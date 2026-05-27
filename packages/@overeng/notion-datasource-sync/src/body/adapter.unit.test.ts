import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NmdStateStore,
  NmdStateStoreLive,
  type NotionMdGatewayShape,
  type PullPageResult,
} from '@overeng/notion-md'

import {
  AbsolutePath,
  BodyPointer,
  CommandId,
  DataSourceId,
  Hash,
  NotionRequestId,
  PageId,
  RowObserved,
  WorkspaceRelativePath,
  bodySafetySnapshot,
  evaluateBodyAdapterContract,
  makeFakePageBodySyncPort,
  makeNotionMdMaterializingLocalWorkspacePort,
  makeNotionMdPageBodySyncPort,
  makeUnsupportedPageBodySyncPort,
  type BodySafetySnapshot,
} from '../mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)
const contentHash = (content: string) =>
  decode(Hash, `sha256:${createHash('sha256').update(content).digest('hex')}`)

const commandId = (value: string) => decode(CommandId, value)
const pageId = decode(PageId, 'page-1')
const dataSourceId = decode(DataSourceId, 'data-source-1')
const requestId = decode(NotionRequestId, 'req-1')

const pointer = decode(BodyPointer, {
  _tag: 'BodyPointer',
  pageId,
  bodyHash: hash('a'),
  observedAt: '2026-05-25T00:00:00.000Z',
})

const fakePort = (safety: BodySafetySnapshot) =>
  makeFakePageBodySyncPort({
    pages: [
      {
        pageId,
        pointer,
        requestId,
        safety,
      },
    ],
  })

const nmdPageId = decode(PageId, '11111111-1111-4111-8111-111111111111')
const nmdPath = decode(WorkspaceRelativePath, 'adapter-page.nmd')

const pullPageResult = (
  input: {
    readonly markdown?: string
    readonly truncated?: boolean
    readonly unknownBlockIds?: readonly string[]
  } = {},
): PullPageResult => ({
  page: {
    id: nmdPageId,
    title: 'Adapter page',
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
    markdown: input.markdown ?? '# Adapter page\n\nHello from NotionMD.\n',
    truncated: input.truncated ?? false,
    unknown_block_ids: input.unknownBlockIds ?? [],
  },
  storage: {
    _tag: 'self_contained',
    unsupported_blocks: [],
    files: [],
    comments: [],
  },
})

const bodyPointerFromTestMarkdown = (markdown: string) =>
  decode(BodyPointer, {
    _tag: 'BodyPointer',
    pageId: nmdPageId,
    bodyHash: contentHash(markdown),
    observedAt: '2026-05-25T00:00:00.000Z',
    safety: bodySafetySnapshot(),
  })

const fakeNotionMdGateway = (
  result: PullPageResult,
  input: {
    readonly updateMarkdown?: NotionMdGatewayShape['updateMarkdown']
  } = {},
): NotionMdGatewayShape => ({
  pullPage: () => Effect.succeed(result),
  updateMarkdown:
    input.updateMarkdown ??
    (() => Effect.die('updateMarkdown should not be called by these tests')),
  updatePageProperties: () =>
    Effect.die('updatePageProperties should not be called by these tests'),
  updatePageMetadata: () => Effect.die('updatePageMetadata should not be called by these tests'),
  listChildPages: () => Effect.succeed([]),
})

const runWithNmdStateStore = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, NmdStateStore>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NmdStateStoreLive), Effect.provide(NodeContext.layer)),
  )

describe('body adapter contract', () => {
  it.each([
    ['unknown', 'MarkdownUnknownBlocksAmbiguous'],
    ['permission', 'MarkdownUnknownBlocksAmbiguous'],
    ['unsupported', 'MarkdownUnknownBlocksAmbiguous'],
    ['truncation', 'BodyLossyRemote'],
  ] as const)('fails closed for unknown-block cause: %s', (unknownBlockCause, guard) => {
    expect(evaluateBodyAdapterContract(bodySafetySnapshot({ unknownBlockCause }))).toMatchObject({
      _tag: 'blocked',
      guard,
    })
  })

  it('guards inconsistent truncation cause even when the truncated flag is absent', () => {
    expect(
      evaluateBodyAdapterContract(
        bodySafetySnapshot({
          truncated: false,
          unknownBlockCause: 'truncation',
        }),
      ),
    ).toMatchObject({
      _tag: 'blocked',
      guard: 'BodyLossyRemote',
    })
  })

  it('turns body adapter surface leaks into named guard results', async () => {
    const safety = bodySafetySnapshot({
      adapterMutationSurfaces: [
        'body',
        'row-property',
        'schema',
        'title',
        'trash',
        'icon',
        'cover',
      ],
    })

    expect(evaluateBodyAdapterContract(safety)).toMatchObject({
      _tag: 'blocked',
      guard: 'BodyAdapterNonBodyMutation',
    })

    const result = await Effect.runPromise(
      fakePort(safety).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'BodyAdapterNonBodyMutation',
    })
  })

  it.each([
    ['truncated body', bodySafetySnapshot({ truncated: true }), 'BodyLossyRemote'],
    [
      'unknown block IDs with unknown cause',
      bodySafetySnapshot({ unknownBlockCause: 'unknown' }),
      'MarkdownUnknownBlocksAmbiguous',
    ],
    [
      'ambiguous markdown selection',
      bodySafetySnapshot({ selection: 'ambiguous' }),
      'MarkdownSelectionAmbiguous',
    ],
    [
      'child page/database deletion',
      bodySafetySnapshot({ wouldDeleteChildren: true }),
      'MarkdownWouldDeleteChildren',
    ],
    [
      'synced page unsupported',
      bodySafetySnapshot({ syncedPageUnsupported: true }),
      'MarkdownSyncedPageUnsupported',
    ],
  ])('blocks lossy or destructive body writes: %s', async (_name, safety, reason) => {
    const result = await Effect.runPromise(
      fakePort(safety).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason,
    })
  })

  it('reports stale body bases as body conflicts before push', async () => {
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer,
          requestId,
          remoteBodyHash: hash('c'),
        },
      ],
    })

    const result = await Effect.runPromise(
      port.planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: pointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'StaleSurfaceBase',
      remoteBodyHash: hash('c'),
    })
  })

  it('rejects queued body pushes whose base pointer is stale after current body changes', async () => {
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer,
          requestId,
        },
      ],
    })

    await expect(
      Effect.runPromise(
        port.push({
          _tag: 'BodyPushCommand',
          commandId: commandId('cmd-1'),
          pageId,
          baseBodyPointer: pointer,
          nextBodyHash: hash('b'),
        }),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodyPushResult',
      bodyPointer: {
        bodyHash: hash('b'),
      },
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.push({
            _tag: 'BodyPushCommand',
            commandId: commandId('cmd-2'),
            pageId,
            baseBodyPointer: pointer,
            nextBodyHash: hash('c'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'push',
      message: expect.stringContaining('StaleSurfaceBase'),
    })
  })

  it('uses observed body pointer safety metadata as the guard source', async () => {
    const safety = bodySafetySnapshot({ unknownBlockCause: 'permission' })
    const port = makeFakePageBodySyncPort({
      pages: [
        {
          pageId,
          pointer: {
            ...pointer,
            safety,
          },
          requestId,
        },
      ],
    })

    const observed = await Effect.runPromise(
      port.observe({
        _tag: 'ObserveBodyInput',
        pageId,
      }),
    )

    expect(observed.safety).toEqual(safety)
    expect(evaluateBodyAdapterContract(observed.safety ?? bodySafetySnapshot())).toMatchObject({
      _tag: 'blocked',
      guard: 'MarkdownUnknownBlocksAmbiguous',
    })
  })

  it('guards unsafe base pointer safety at the composition boundary', async () => {
    const unsafePointer = {
      ...pointer,
      safety: bodySafetySnapshot({ truncated: true }),
    }

    const result = await Effect.runPromise(
      fakePort(bodySafetySnapshot()).planLocalChange({
        _tag: 'BodyLocalChangeInput',
        pageId,
        baseBodyPointer: unsafePointer,
        localBodyHash: hash('b'),
      }),
    )

    expect(result).toMatchObject({
      _tag: 'BodyConflict',
      reason: 'BodyLossyRemote',
      baseBodyPointer: {
        safety: unsafePointer.safety,
      },
    })
  })

  it('fails closed when no concrete NotionMD body adapter is configured', async () => {
    const port = makeUnsupportedPageBodySyncPort()

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.observe({
            _tag: 'ObserveBodyInput',
            pageId,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'observe',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.push({
            _tag: 'BodyPushCommand',
            commandId: commandId('cmd-unsupported'),
            pageId,
            baseBodyPointer: pointer,
            nextBodyHash: hash('b'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'push',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.planLocalChange({
            _tag: 'BodyLocalChangeInput',
            pageId,
            baseBodyPointer: pointer,
            localBodyHash: hash('b'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'planLocalChange',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.repair({
            _tag: 'BodyRepairInput',
            pageId,
            currentBodyPointer: pointer,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'repair',
      message: expect.stringContaining('No NotionMD page body adapter'),
    })
  })

  it('keeps replayed row body pointer safety usable for guards', () => {
    const safety = bodySafetySnapshot({ syncedPageUnsupported: true })
    const event = decode(RowObserved, {
      _tag: 'RowObserved',
      eventId: 'event-1',
      rootId: 'root-1',
      sequence: '1',
      codecVersion: 'v1',
      family: 'RemoteObserved',
      eventType: 'RowObserved',
      idempotencyKey: 'idem-1',
      surface: null,
      causedByEventIds: [],
      payloadHash: hash('d'),
      payload: {
        _tag: 'VersionedJson',
        codecVersion: 'v1',
        canonicalJson: '{}',
      },
      observedAt: '2026-05-25T00:00:00.000Z',
      dataSourceId,
      pageId,
      propertiesHash: hash('e'),
      bodyPointer: {
        _tag: 'BodyPointer',
        pageId,
        bodyHash: hash('a'),
        observedAt: '2026-05-25T00:00:00.000Z',
        safety,
      },
      inTrash: false,
    })

    expect(event.bodyPointer?.safety).toEqual(safety)
    expect(
      evaluateBodyAdapterContract(event.bodyPointer?.safety ?? bodySafetySnapshot()),
    ).toMatchObject({
      _tag: 'blocked',
      guard: 'MarkdownSyncedPageUnsupported',
    })
  })

  it('observes NotionMD markdown through the public gateway and derives fail-closed safety', async () => {
    const markdown = '# Adapter page\n\nBody from NotionMD.\n'
    const port = makeNotionMdPageBodySyncPort({
      gateway: fakeNotionMdGateway(
        pullPageResult({
          markdown,
          unknownBlockIds: ['22222222-2222-4222-8222-222222222222'],
        }),
      ),
    })

    const observed = await Effect.runPromise(
      port.observe({
        _tag: 'ObserveBodyInput',
        pageId: nmdPageId,
      }),
    )

    expect(observed).toMatchObject({
      _tag: 'BodyPointer',
      pageId: nmdPageId,
      bodyHash: contentHash(markdown),
      safety: {
        unknownBlockCause: 'unknown',
        adapterMutationSurfaces: ['body'],
      },
    })
    expect(evaluateBodyAdapterContract(observed.safety ?? bodySafetySnapshot())).toMatchObject({
      _tag: 'blocked',
      guard: 'MarkdownUnknownBlocksAmbiguous',
    })
  })

  it('materializes real .nmd files and notion-md sidecars through the NotionMD adapter', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'notion-ds-sync-nmd-adapter-'))
    const root = decode(AbsolutePath, rootPath)
    const markdown = '# Adapter page\n\nMaterialized through NotionMD.\n'
    const bodyPointer = decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId: nmdPageId,
      bodyHash: contentHash(markdown),
      observedAt: '2026-05-25T00:00:00.000Z',
      safety: bodySafetySnapshot(),
    })
    const gateway = fakeNotionMdGateway(pullPageResult({ markdown }))

    try {
      const result = await runWithNmdStateStore(
        Effect.gen(function* () {
          const stateStore = yield* NmdStateStore
          const port = makeNotionMdMaterializingLocalWorkspacePort({
            root,
            gateway,
            stateStore,
          })
          return yield* port.materialize({
            _tag: 'MaterializePlan',
            pageId: nmdPageId,
            path: nmdPath,
            bodyPointer,
          })
        }),
      )
      const nmdContent = await readFile(join(rootPath, nmdPath), 'utf8')
      const notionMdSidecar = await readFile(
        join(rootPath, '.notion-md', 'sync', `${nmdPageId}.json`),
        'utf8',
      )
      const datasourceSidecar = await readFile(
        join(rootPath, '.notion-datasource-sync', 'pages', `${encodeURIComponent(nmdPageId)}.json`),
        'utf8',
      )

      expect(result).toMatchObject({
        _tag: 'MaterializeResult',
        pageId: nmdPageId,
        path: nmdPath,
        bodyHash: bodyPointer.bodyHash,
      })
      expect(nmdContent).toContain('"page_id": "11111111-1111-4111-8111-111111111111"')
      expect(nmdContent).toContain('Materialized through NotionMD.')
      expect(JSON.parse(notionMdSidecar)).toMatchObject({
        version: 1,
        page_id: nmdPageId,
        body: {
          hash: bodyPointer.bodyHash,
        },
      })
      expect(JSON.parse(datasourceSidecar)).toMatchObject({
        version: 1,
        pageId: nmdPageId,
        path: nmdPath,
        bodyHash: bodyPointer.bodyHash,
      })

      const observations = await runWithNmdStateStore(
        Effect.gen(function* () {
          const stateStore = yield* NmdStateStore
          const port = makeNotionMdMaterializingLocalWorkspacePort({
            root,
            gateway,
            stateStore,
          })
          return yield* port.scan(root).pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
        }),
      )
      expect(observations).toEqual([
        expect.objectContaining({
          _tag: 'LocalArtifactObservation',
          pageId: nmdPageId,
          path: nmdPath,
          contentHash: bodyPointer.bodyHash,
          state: 'present',
          ownWriteSuppressionToken: result.ownWriteSuppressionToken,
        }),
      ])

      const editedMarkdown = '# Adapter page\n\nEdited locally through NotionMD.\n'
      await writeFile(
        join(rootPath, nmdPath),
        nmdContent.replace('Materialized through NotionMD.', 'Edited locally through NotionMD.'),
        'utf8',
      )

      const editedObservations = await runWithNmdStateStore(
        Effect.gen(function* () {
          const stateStore = yield* NmdStateStore
          const port = makeNotionMdMaterializingLocalWorkspacePort({
            root,
            gateway,
            stateStore,
          })
          return yield* port.scan(root).pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
        }),
      )
      expect(editedObservations).toEqual([
        expect.objectContaining({
          _tag: 'LocalArtifactObservation',
          pageId: nmdPageId,
          path: nmdPath,
          contentHash: contentHash(editedMarkdown),
          bodyContent: editedMarkdown,
          state: 'present',
        }),
      ])
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  it('pushes NotionMD body content when the command carries the local path and markdown body', async () => {
    const localBodyContent = '# Adapter page\n\nPushed through datasource-sync.\n'
    const updates: Parameters<NotionMdGatewayShape['updateMarkdown']>[0][] = []
    const port = makeNotionMdPageBodySyncPort({
      gateway: fakeNotionMdGateway(pullPageResult(), {
        updateMarkdown: (opts) =>
          Effect.sync(() => {
            updates.push(opts)
            return {
              markdown: {
                markdown: localBodyContent,
                truncated: false,
                unknown_block_ids: [],
              },
            }
          }),
      }),
    })

    const result = await Effect.runPromise(
      port.push({
        _tag: 'BodyPushCommand',
        commandId: commandId('cmd-notion-md-push'),
        pageId: nmdPageId,
        baseBodyPointer: bodyPointerFromTestMarkdown('# Adapter page\n\nHello from NotionMD.\n'),
        nextBodyHash: contentHash(localBodyContent),
        localBodyPath: nmdPath,
        localBodyContent,
      }),
    )

    expect(updates).toEqual([
      {
        pageId: nmdPageId,
        command: {
          _tag: 'replace_content',
          markdown: localBodyContent,
        },
        allowDeletingContent: false,
      },
    ])
    expect(result).toMatchObject({
      _tag: 'BodyPushResult',
      pageId: nmdPageId,
      bodyPointer: {
        bodyHash: contentHash(localBodyContent),
        safety: bodySafetySnapshot(),
      },
    })
  })

  it('keeps NotionMD body push fail-closed when queued commands lack body content', async () => {
    const port = makeNotionMdPageBodySyncPort({
      gateway: fakeNotionMdGateway(pullPageResult()),
    })

    await expect(
      Effect.runPromise(
        Effect.flip(
          port.push({
            _tag: 'BodyPushCommand',
            commandId: commandId('cmd-notion-md-push-gap'),
            pageId: nmdPageId,
            baseBodyPointer: bodyPointerFromTestMarkdown(
              '# Adapter page\n\nHello from NotionMD.\n',
            ),
            nextBodyHash: hash('b'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'BodySyncError',
      operation: 'push',
      message: expect.stringContaining('requires a datasource-sync command'),
    })
  })
})
