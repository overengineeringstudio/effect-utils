import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  makeNmdObjectRef,
  NOTION_API_VERSION,
  type NmdFrontmatterV2,
  type NmdObjectRef,
  type NmdStorage,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

import {
  materializeBody,
  NotionMdBodyConflictError,
  readLocalBody,
  replaceRemoteBodyVerified,
  settleVerifiedBodyPush,
} from './body-facade.ts'
import { renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import {
  NotionMdGateway,
  type MarkdownUpdateCommand,
  type NotionMdGatewayShape,
  type PullPageResult,
} from './model.ts'
import { NmdStateStore, type NmdStateStoreShape } from './state-store.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const path = '/tmp/page.nmd'

const emptyStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [],
})

const frontmatter = (title: string): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: NOTION_API_VERSION,
    object: 'page',
    page_id: pageId,
    url: 'https://notion.so/page',
    parent: { _tag: 'workspace' },
    page: {
      title,
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    properties: {},
  },
})

const pullResult = (markdown: string): PullPageResult => ({
  page: {
    id: pageId,
    title: 'Remote page',
    title_property_key: 'title',
    url: 'https://notion.so/page',
    parent: { type: 'workspace', workspace: true },
    icon: null,
    cover: null,
    in_trash: false,
    is_locked: false,
    last_edited_time: '2026-05-22T12:00:00.000Z',
    properties: {},
  },
  markdown: {
    markdown,
    truncated: false,
    unknown_block_ids: [],
  },
  storage: emptyStorage(),
})

class FakeStore {
  private nmdContent = new Map<string, string>()
  readonly writeNmdFileCalls: Array<{ readonly path: string; readonly content: string }> = []
  readonly writeBaseSnapshotCalls: Array<{
    readonly path: string
    readonly pageId: string
    readonly body: string
  }> = []
  readonly writeSyncStateCalls: Array<{
    readonly path: string
    readonly syncState: NmdSyncStateV1
  }> = []

  constructor(files: ReadonlyMap<string, string> = new Map()) {
    this.nmdContent = new Map(files)
  }

  readonly layer = Layer.succeed(NmdStateStore, {
    readNmdFile: ({ path: filePath }) =>
      Effect.sync(() => {
        const content = this.nmdContent.get(filePath)
        if (content === undefined) throw new Error(`Missing fake .nmd file ${filePath}`)
        return content
      }),
    writeNmdFile: ({ path: filePath, content }) =>
      Effect.sync(() => {
        this.writeNmdFileCalls.push({ path: filePath, content })
        this.nmdContent.set(filePath, content)
      }),
    writeConflictFile: () => Effect.dieMessage('unexpected writeConflictFile call'),
    writeBaseSnapshot: (opts) =>
      Effect.sync((): NmdObjectRef => {
        this.writeBaseSnapshotCalls.push(opts)
        const content = JSON.stringify({
          version: 2,
          page_id: opts.pageId,
          body_hash: sha256Digest(normalizeMarkdownLineEndings(opts.body)),
          body: normalizeMarkdownLineEndings(opts.body),
        })
        return makeNmdObjectRef({
          role: 'base_snapshot',
          hash: sha256Digest(content),
          content,
        })
      }),
    readBaseSnapshot: () => Effect.dieMessage('unexpected readBaseSnapshot call'),
    writeStorageObject: () => Effect.dieMessage('unexpected writeStorageObject call'),
    validateReferencedObjects: () => Effect.dieMessage('unexpected validateReferencedObjects call'),
    writeSyncState: (opts) =>
      Effect.sync(() => {
        this.writeSyncStateCalls.push(opts)
      }),
    readSyncState: () => Effect.dieMessage('unexpected readSyncState call'),
    readSyncStateOptional: () => Effect.dieMessage('unexpected readSyncStateOptional call'),
  } satisfies NmdStateStoreShape)
}

class FakeGateway {
  private markdown: string
  readonly pullPageCalls: Array<{ readonly pageId: string }> = []
  readonly updateMarkdownCalls: Array<{
    readonly pageId: string
    readonly command: MarkdownUpdateCommand
    readonly allowDeletingContent: boolean
  }> = []
  readonly metadataUpdateCalls: string[] = []

  constructor(markdown: string) {
    this.markdown = normalizeMarkdownLineEndings(markdown)
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: ({ pageId: id }) =>
      Effect.sync(() => {
        this.pullPageCalls.push({ pageId: id })
        return pullResult(this.markdown)
      }),
    updateMarkdown: ({ pageId: id, command, allowDeletingContent }) =>
      Effect.sync(() => {
        this.updateMarkdownCalls.push({ pageId: id, command, allowDeletingContent })
        this.markdown =
          command._tag === 'replace_content'
            ? normalizeMarkdownLineEndings(command.markdown)
            : normalizeMarkdownLineEndings(command.expectedMarkdown)
        return pullResult(this.markdown)
      }),
    updatePageProperties: () =>
      Effect.sync(() => {
        this.metadataUpdateCalls.push('properties')
        throw new Error('unexpected metadata update')
      }),
    updatePageMetadata: () =>
      Effect.sync(() => {
        this.metadataUpdateCalls.push('metadata')
        throw new Error('unexpected metadata update')
      }),
    listChildPages: () => Effect.succeed([]),
    createPage: () =>
      Effect.sync(() => {
        throw new Error('unexpected createPage')
      }),
    movePage: () =>
      Effect.sync(() => {
        throw new Error('unexpected movePage')
      }),
    archivePage: () =>
      Effect.sync(() => {
        throw new Error('unexpected archivePage')
      }),
  } satisfies NotionMdGatewayShape)
}

const runWithStore = <A, E>(effect: Effect.Effect<A, E, NmdStateStore>, store: FakeStore) =>
  Effect.runPromise(effect.pipe(Effect.provide(store.layer)))

const runWithGateway = <A, E>(effect: Effect.Effect<A, E, NotionMdGateway>, gateway: FakeGateway) =>
  Effect.runPromise(effect.pipe(Effect.provide(gateway.layer)))

const runWithGatewayAndStore = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore>,
  gateway: FakeGateway,
  store: FakeStore,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(gateway.layer, store.layer))))

describe('notion-md body facade', () => {
  it('hashes the parsed body, not frontmatter', async () => {
    const body = normalizeMarkdownLineEndings('Body\n')
    const content = renderNmdFile({ frontmatter: frontmatter('Frontmatter title'), body })
    const store = new FakeStore(new Map([[path, content]]))

    const local = await runWithStore(readLocalBody({ path }), store)

    expect(local.markdown).toBe(body)
    expect(local.bodyHash).toBe(sha256Digest(body))
    expect(local.bodyHash).not.toBe(sha256Digest(content))
  })

  it('materializes through the existing pullPage write path', async () => {
    const gateway = new FakeGateway('Remote body\n')
    const store = new FakeStore()

    const materialized = await runWithGatewayAndStore(
      materializeBody({ pageId, outPath: path }),
      gateway,
      store,
    )

    expect(materialized.bodyHash).toBe(sha256Digest(normalizeMarkdownLineEndings('Remote body\n')))
    expect(materialized.pull).toMatchObject({ path, pageId, storage: 'self_contained' })
    expect(store.writeBaseSnapshotCalls).toHaveLength(1)
    expect(store.writeSyncStateCalls).toHaveLength(1)
    expect(store.writeNmdFileCalls).toHaveLength(1)
    expect(store.writeNmdFileCalls[0]?.content).toContain('Remote body')
  })

  it('uses replace_content with allowDeletingContent false for verified remote replacement', async () => {
    const gateway = new FakeGateway('Base body\n')
    const baseBodyHash = sha256Digest(normalizeMarkdownLineEndings('Base body\n'))

    const result = await runWithGateway(
      replaceRemoteBodyVerified({ pageId, baseBodyHash, markdown: 'Next body\n' }),
      gateway,
    )

    expect(result.previousBodyHash).toBe(baseBodyHash)
    expect(result.bodyHash).toBe(sha256Digest(normalizeMarkdownLineEndings('Next body\n')))
    expect(gateway.updateMarkdownCalls).toEqual([
      {
        pageId,
        command: { _tag: 'replace_content', markdown: 'Next body\n' },
        allowDeletingContent: false,
      },
    ])
    expect(gateway.pullPageCalls).toEqual([{ pageId }, { pageId }])
    expect(gateway.metadataUpdateCalls).toEqual([])
  })

  it('refuses verified remote replacement when the remote base is stale', async () => {
    const gateway = new FakeGateway('Remote changed\n')
    const staleBaseHash = sha256Digest(normalizeMarkdownLineEndings('Old base\n'))

    const error = await runWithGateway(
      replaceRemoteBodyVerified({
        pageId,
        baseBodyHash: staleBaseHash,
        markdown: 'Next body\n',
      }).pipe(Effect.flip),
      gateway,
    )

    expect(error).toBeInstanceOf(NotionMdBodyConflictError)
    expect(gateway.updateMarkdownCalls).toEqual([])
  })

  it('settles verified push through the existing pullPage materialization path', async () => {
    const body = normalizeMarkdownLineEndings('Pushed body\n')
    const content = renderNmdFile({
      frontmatter: frontmatter('Local title'),
      body,
    })
    const gateway = new FakeGateway(body)
    const store = new FakeStore(new Map([[path, content]]))
    const expectedLocalBodyHash = sha256Digest(body)

    const settled = await runWithGatewayAndStore(
      settleVerifiedBodyPush({ pageId, path, expectedLocalBodyHash }),
      gateway,
      store,
    )

    expect(settled).toMatchObject({
      pageId,
      path,
      localBodyHash: expectedLocalBodyHash,
      remoteBodyHash: expectedLocalBodyHash,
      remoteMarkdown: body,
    })
    expect(settled.localFileContentHash).toBe(
      sha256Digest(store.writeNmdFileCalls[0]?.content ?? ''),
    )
    expect(gateway.pullPageCalls).toEqual([{ pageId }])
    expect(store.writeBaseSnapshotCalls).toHaveLength(1)
    expect(store.writeSyncStateCalls).toHaveLength(1)
    expect(store.writeNmdFileCalls).toHaveLength(1)
    expect(store.writeNmdFileCalls[0]?.content).toContain(body)
    expect(gateway.updateMarkdownCalls).toEqual([])
    expect(gateway.metadataUpdateCalls).toEqual([])
  })

  it('refuses settlement without writing when the local body changed', async () => {
    const content = renderNmdFile({
      frontmatter: frontmatter('Local title'),
      body: 'Changed local body\n',
    })
    const gateway = new FakeGateway('Remote body\n')
    const store = new FakeStore(new Map([[path, content]]))
    const expectedLocalBodyHash = sha256Digest(normalizeMarkdownLineEndings('Old local body\n'))

    const error = await runWithGatewayAndStore(
      settleVerifiedBodyPush({ pageId, path, expectedLocalBodyHash }).pipe(Effect.flip),
      gateway,
      store,
    )

    expect(error).toBeInstanceOf(NotionMdBodyConflictError)
    expect(gateway.pullPageCalls).toEqual([])
    expect(store.writeBaseSnapshotCalls).toEqual([])
    expect(store.writeSyncStateCalls).toEqual([])
    expect(store.writeNmdFileCalls).toEqual([])
  })
})
