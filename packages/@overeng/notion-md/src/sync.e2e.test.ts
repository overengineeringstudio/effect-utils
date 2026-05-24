import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Fiber, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdPageState, NmdStorage, NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { resolveNmdTargets, runBatchWatch, syncMany } from './batch.ts'
import { runWatch } from './cli-program.ts'
import {
  NmdConflictError,
  NmdFrontmatterError,
  NmdGatewayError,
  NmdObjectStoreError,
} from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway, type MarkdownUpdateCommand, type PullPageResult } from './model.ts'
import {
  NmdStateStoreLive,
  objectPath,
  objectRelativePath,
  type NmdStateStore,
} from './state-store.ts'
import { pullPage, pushPage, statusPage, syncPage } from './sync.ts'
import {
  isManagedWorkspace,
  statusWorkspace,
  syncRemoteToTarget,
  syncWorkspace,
} from './workspace.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const secondPageId = '00000000-0000-4000-8000-000000000011'
const blockId = '00000000-0000-4000-8000-000000000002'
const fileBlockId = '00000000-0000-4000-8000-000000000003'
const hash = `sha256:${'a'.repeat(64)}` as const

interface FakePage {
  readonly pageId: string
  readonly title: string
  readonly markdown: string
  readonly childPageIds?: readonly string[]
  readonly icon?: NmdPageState['icon']
  readonly cover?: NmdPageState['cover']
  readonly inTrash?: boolean
  readonly isLocked?: boolean
  readonly storage?: NmdStorage
  readonly properties?: Record<string, unknown>
  readonly unknownBlockIds?: readonly string[]
  readonly lastEditedTime?: string
}

const unsupportedStorage = (payload: unknown = { url: 'https://www.notion.com/' }): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [
    {
      _tag: 'unsupported_block',
      block_id: blockId,
      block_type: 'bookmark',
      placeholder: '<unknown url="https://www.notion.com/" alt="bookmark"/>',
      snapshot: {
        object: 'block',
        id: blockId,
        type: 'bookmark',
        has_children: false,
        in_trash: false,
        parent: { type: 'page_id', page_id: pageId },
        created_time: '2026-05-22T12:00:00.000Z',
        last_edited_time: '2026-05-22T12:00:00.000Z',
        payload,
      },
    },
  ],
  files: [
    {
      _tag: 'file_unit',
      id: 'hero-image',
      role: 'block_image',
      filename: 'hero.png',
      content_type: 'image/png',
      content_length: 70,
      local_path: 'attachments/hero.png',
      content_hash: hash,
      block_id: fileBlockId,
    },
  ],
  comments: [
    {
      _tag: 'comment_unit',
      id: 'roughdraft-1',
      roughdraft_id: 'roughdraft-1',
      anchor_text: 'Body',
    },
  ],
})

class FakeNotion {
  private readonly pages = new Map<string, Required<FakePage>>()
  private tick = 0
  private afterPagePropertiesUpdate: (() => void) | undefined
  readonly updateMarkdownCalls: Array<{
    readonly pageId: string
    readonly allowDeletingContent: boolean
    readonly command: MarkdownUpdateCommand['_tag']
    readonly markdown: string
  }> = []

  constructor(pages: readonly FakePage[]) {
    for (const page of pages) {
      this.pages.set(page.pageId, {
        storage: {
          _tag: 'self_contained',
          unsupported_blocks: [],
          files: [],
          comments: [],
        },
        properties: {},
        unknownBlockIds: [],
        childPageIds: [],
        icon: null,
        cover: null,
        inTrash: false,
        isLocked: false,
        lastEditedTime: '2026-05-22T12:00:00.000Z',
        ...page,
      })
    }
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: ({ pageId: id }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
        return this.toPullResult(page)
      }),
    updateMarkdown: ({ pageId: id, command, allowDeletingContent }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
        const markdown =
          command._tag === 'replace_content'
            ? command.markdown
            : command.contentUpdates.reduce((body, update) => {
                const occurrences = body.split(update.oldStr).length - 1
                if (occurrences === 0 || (update.replaceAllMatches !== true && occurrences > 1)) {
                  throw new NmdGatewayError({
                    operation: 'update_markdown',
                    page_id: id,
                    message: 'Fake Notion rejected ambiguous update_content command',
                  })
                }
                return update.replaceAllMatches === true
                  ? body.replaceAll(update.oldStr, update.newStr)
                  : body.replace(update.oldStr, update.newStr)
              }, page.markdown)
        if (
          command._tag === 'update_content' &&
          normalizeMarkdownLineEndings(markdown) !==
            normalizeMarkdownLineEndings(command.expectedMarkdown)
        ) {
          throw new NmdGatewayError({
            operation: 'update_markdown',
            page_id: id,
            message: 'Fake Notion update_content result did not match expected Markdown',
          })
        }
        this.updateMarkdownCalls.push({
          pageId: id,
          allowDeletingContent,
          command: command._tag,
          markdown: normalizeMarkdownLineEndings(markdown),
        })
        this.tick += 1
        const nextStorage =
          allowDeletingContent === true &&
          normalizeMarkdownLineEndings(markdown).includes('<unknown') === false
            ? ({
                _tag: 'self_contained',
                unsupported_blocks: [],
                files: [],
                comments: [],
              } satisfies NmdStorage)
            : page.storage
        const nextUnknownBlockIds =
          allowDeletingContent === true &&
          normalizeMarkdownLineEndings(markdown).includes('<unknown') === false
            ? []
            : page.unknownBlockIds
        const next = {
          ...page,
          markdown: normalizeMarkdownLineEndings(markdown),
          storage: nextStorage,
          unknownBlockIds: nextUnknownBlockIds,
          lastEditedTime: `2026-05-22T12:00:0${this.tick}.000Z`,
        }
        this.pages.set(id, next)
        return {
          markdown: {
            markdown: next.markdown,
            truncated: next.unknownBlockIds.length > 0,
            unknown_block_ids: next.unknownBlockIds,
          },
        }
      }),
    updatePageProperties: ({ pageId: id, properties }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
        const next = {
          ...page,
          properties: { ...page.properties, ...properties },
        }
        this.pages.set(id, next)
        const afterUpdate = this.afterPagePropertiesUpdate
        this.afterPagePropertiesUpdate = undefined
        afterUpdate?.()
        return this.toPullResult(next).page
      }),
    updatePageMetadata: ({ pageId: id, metadata }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
        const next = {
          ...page,
          title: metadata.title === undefined ? page.title : metadata.title.value,
          icon: metadata.icon === undefined ? page.icon : metadata.icon,
          cover: metadata.cover === undefined ? page.cover : metadata.cover,
          inTrash: metadata.in_trash === undefined ? page.inTrash : metadata.in_trash,
          isLocked: metadata.is_locked === undefined ? page.isLocked : metadata.is_locked,
        }
        this.pages.set(id, next)
        return this.toPullResult(next).page
      }),
    listChildPages: ({ pageId: id }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
        return page.childPageIds.map((childPageId) => {
          const child = this.requirePage(childPageId)
          return { pageId: child.pageId, title: child.title }
        })
      }),
  })

  mutateRemote(pageIdToMutate: string, markdown: string): void {
    const page = this.requirePage(pageIdToMutate)
    this.tick += 1
    this.pages.set(pageIdToMutate, {
      ...page,
      markdown: normalizeMarkdownLineEndings(markdown),
      lastEditedTime: `2026-05-22T12:00:0${this.tick}.000Z`,
    })
  }

  mutateRemoteAfterNextPropertyUpdate(pageIdToMutate: string, markdown: string): void {
    this.afterPagePropertiesUpdate = () => {
      this.mutateRemote(pageIdToMutate, markdown)
    }
  }

  runAfterNextPropertyUpdate(callback: () => void): void {
    this.afterPagePropertiesUpdate = callback
  }

  touchRemoteMetadata(pageIdToMutate: string): void {
    const page = this.requirePage(pageIdToMutate)
    this.tick += 1
    this.pages.set(pageIdToMutate, {
      ...page,
      lastEditedTime: `2026-05-22T12:00:0${this.tick}.000Z`,
    })
  }

  setStorage(pageIdToMutate: string, storage: NmdStorage): void {
    const page = this.requirePage(pageIdToMutate)
    this.pages.set(pageIdToMutate, { ...page, storage })
  }

  setChildPages(pageIdToMutate: string, childPageIds: readonly string[]): void {
    const page = this.requirePage(pageIdToMutate)
    this.pages.set(pageIdToMutate, { ...page, childPageIds })
  }

  remoteMarkdown(pageIdToRead: string): string {
    return this.requirePage(pageIdToRead).markdown
  }

  remoteProperties(pageIdToRead: string): Record<string, unknown> {
    return this.requirePage(pageIdToRead).properties
  }

  remoteMetadata(pageIdToRead: string): {
    readonly title: string
    readonly icon: NmdPageState['icon']
    readonly cover: NmdPageState['cover']
    readonly in_trash: boolean
    readonly is_locked: boolean
  } {
    const page = this.requirePage(pageIdToRead)
    return {
      title: page.title,
      icon: page.icon,
      cover: page.cover,
      in_trash: page.inTrash,
      is_locked: page.isLocked,
    }
  }

  private requirePage(id: string): Required<FakePage> {
    const page = this.pages.get(id)
    if (page === undefined) {
      throw new Error(`Unknown fake page: ${id}`)
    }
    return page
  }

  private toPullResult(page: Required<FakePage>): PullPageResult {
    return {
      page: {
        id: page.pageId,
        title: page.title,
        title_property_key: 'title',
        url: `https://www.notion.so/${page.pageId.replaceAll('-', '')}`,
        parent: { type: 'page_id', page_id: pageId },
        icon: page.icon,
        cover: page.cover,
        in_trash: page.inTrash,
        is_locked: page.isLocked,
        last_edited_time: page.lastEditedTime,
        properties: page.properties,
      },
      markdown: {
        markdown: normalizeMarkdownLineEndings(page.markdown),
        truncated: page.unknownBlockIds.length > 0,
        unknown_block_ids: page.unknownBlockIds,
      },
      storage: page.storage,
    }
  }
}

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-e2e-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

const runWithFake = <A>(
  effect: Effect.Effect<A, unknown, NodeContext.NodeContext | NotionMdGateway | NmdStateStore>,
  fake: FakeNotion,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer, NodeContext.layer))),
  )

const runEitherWithFake = <A, E>(
  effect: Effect.Effect<A, E, NotionMdGateway | NmdStateStore>,
  fake: FakeNotion,
) =>
  Effect.runPromise(
    effect.pipe(Effect.either, Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer))),
  )

const parseFile = async (path: string) => {
  const content = await readFile(path, 'utf8')
  return Effect.runPromise(parseNmdFile({ path, content }))
}

/*
 * After the V2 split derived sync state (body hash, base ref, storage,
 * read-only echoes) lives in `.notion-md/sync/{page_id}.json`. Tests need
 * the same content the engine reads, so this helper resolves the parsed
 * `.nmd` to its sidecar without going through `NmdStateStore` (which
 * requires an effect runtime that not every test fixture wants).
 */
const readSyncStateFile = async (path: string): Promise<NmdSyncStateV1> => {
  const parsed = await parseFile(path)
  const pageId = parsed.frontmatter.notion_md.page_id
  const baseName = path.split(/[\\/]/u).at(-1) ?? path
  const root = path.slice(0, Math.max(0, path.length - baseName.length))
  const sidecarPath = `${root}.notion-md/sync/${pageId}.json`
  return JSON.parse(await readFile(sidecarPath, 'utf8')) as NmdSyncStateV1
}

const baseSnapshotObjectPath = async (path: string): Promise<string> => {
  const syncState = await readSyncStateFile(path)
  return objectPath({ path, hash: syncState.body.base.hash })
}

const readBaseSnapshotFile = async (
  path: string,
): Promise<{
  readonly version: number
  readonly page_id: string
  readonly body_hash: string
  readonly body: string
}> => JSON.parse(await readFile(await baseSnapshotObjectPath(path), 'utf8'))

describe('notion-md e2e prototype', () => {
  it('pulls a clean page into one self-contained .nmd file and reports clean status', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Status: { type: 'select', select: { name: 'Ready' } } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      const pull = await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const status = await runWithFake(statusPage({ path }), fake)
      const base = await readBaseSnapshotFile(path)
      const syncState = await readSyncStateFile(path)

      expect(pull.storage).toBe('self_contained')
      expect(base).toMatchObject({
        version: 2,
        page_id: pageId,
        body: '# Probe\n\nBody\n',
      })
      expect(syncState.storage._tag).toBe('self_contained')
      expect(syncState.read_only_properties.Status).toEqual({
        property_type: 'select',
        value: { type: 'select', select: { name: 'Ready' } },
      })
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
    })
  })

  it('pushes a guarded local edit and refreshes the local clean base', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))

      const pushed = await runWithFake(pushPage({ path }), fake)
      const status = await runWithFake(statusPage({ path }), fake)

      expect(pushed.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toContain('Local body')
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
    })
  })

  it('sync pushes local-only edits through the guarded push path', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))

      const synced = await runWithFake(syncPage({ path }), fake)
      const status = await runWithFake(statusPage({ path }), fake)

      expect(synced._tag).toBe('pushed')
      expect(fake.remoteMarkdown(pageId)).toContain('Local body')
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
    })
  })

  it('watch mode runs sync passes inside an interruptible Effect fiber', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Watched body'))

      await runWithFake(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(
              runWatch({
                syncOptions: { path },
                pollIntervalMs: 10_000,
                emit: () => Effect.void,
              }),
            )
            yield* Effect.sleep('500 millis')
            yield* Fiber.interrupt(fiber)
          }),
        ),
        fake,
      )

      expect(fake.remoteMarkdown(pageId)).toContain('Watched body')
    })
  })

  it('watch mode emits sync results and keeps polling independent from file events', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')
      const events: unknown[] = []

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')

      await runWithFake(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(
              runWatch({
                syncOptions: { path },
                pollIntervalMs: 50,
                emit: (event) =>
                  Effect.sync(() => {
                    events.push(event)
                  }),
              }),
            )
            yield* Effect.sleep('1200 millis')
            yield* Fiber.interrupt(fiber)
          }),
        ),
        fake,
      )

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'sync',
          reason: expect.stringMatching(/^(initial|poll)$/u),
          result: expect.objectContaining({ _tag: 'pulled' }),
        }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'sync',
          reason: 'poll',
          result: expect.objectContaining({ _tag: 'noop' }),
        }),
      )
    })
  })

  it('watch mode emits structured sync errors and continues running', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'missing.nmd')
      const events: unknown[] = []

      await runWithFake(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(
              runWatch({
                syncOptions: { path },
                pollIntervalMs: 10_000,
                emit: (event) =>
                  Effect.sync(() => {
                    events.push(event)
                  }),
              }),
            )
            yield* Effect.sleep('500 millis')
            yield* Fiber.interrupt(fiber)
          }),
        ),
        fake,
      )

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'sync_error',
          reason: 'initial',
          error: expect.objectContaining({
            _tag: 'NmdFileSystemError',
            operation: 'read_nmd',
            path,
          }),
        }),
      )
    })
  })

  it('sync pulls remote-only edits into the existing local file', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')

      const synced = await runWithFake(syncPage({ path }), fake)
      const parsed = await parseFile(path)
      const status = await runWithFake(statusPage({ path }), fake)

      expect(synced._tag).toBe('pulled')
      expect(parsed.body).toContain('Remote body')
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
    })
  })

  it('unified sync can materialize one remote page into a local file target', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      const result = await runWithFake(syncRemoteToTarget({ pageId, target: path }), fake)
      const parsed = await parseFile(path)

      expect('pageId' in result ? result.pageId : undefined).toBe(pageId)
      expect(parsed.frontmatter.notion_md.page_id).toBe(pageId)
      expect(parsed.body).toContain('Body')
    })
  })

  it('does not treat existing .nmd file targets as managed workspaces', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'probe.nmd')
      await writeFile(path, 'local notes\n')

      const managed = await Effect.runPromise(
        isManagedWorkspace(path).pipe(Effect.provide(NodeContext.layer)),
      )

      expect(managed).toBe(false)
    })
  })

  it('workspace sync materializes missing remote child pages into an empty local directory', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Root',
          markdown: '# Root\n\nBody',
          childPageIds: [secondPageId],
        },
        { pageId: secondPageId, title: 'Child Page', markdown: '# Child Page\n\nChild body' },
      ])

      const result = await runWithFake(syncRemoteToTarget({ pageId, target: dir }), fake)
      const root = await parseFile(join(dir, 'index.nmd'))
      const child = await parseFile(join(dir, 'child-page.nmd'))
      const manifest = JSON.parse(await readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8'))

      expect('_tag' in result ? result._tag : undefined).toBe('workspace')
      const materialized = 'materialized' in result ? result.materialized : []
      expect(materialized.map((item) => item.pageId).toSorted()).toEqual(
        [pageId, secondPageId].toSorted(),
      )
      expect(root.frontmatter.notion_md.page_id).toBe(pageId)
      expect(child.frontmatter.notion_md.page_id).toBe(secondPageId)
      expect(manifest.pages[pageId]).toBe('index.nmd')
      expect(manifest.pages[secondPageId]).toBe('child-page.nmd')
    })
  })

  it('workspace sync pulls newly added remote child pages after initial materialization', async () => {
    await withTempDir(async (dir) => {
      const thirdPageId = '00000000-0000-4000-8000-000000000021'
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Root',
          markdown: '# Root\n\nBody',
          childPageIds: [secondPageId],
        },
        { pageId: secondPageId, title: 'First Child', markdown: '# First Child\n\nBody' },
        { pageId: thirdPageId, title: 'Second Child', markdown: '# Second Child\n\nBody' },
      ])

      await runWithFake(syncRemoteToTarget({ pageId, target: dir }), fake)
      fake.setChildPages(pageId, [secondPageId, thirdPageId])

      const result = await runWithFake(syncWorkspace({ root: dir }), fake)
      const child = await parseFile(join(dir, 'second-child.nmd'))

      expect(result.materialized.map((item) => item.pageId)).toContain(thirdPageId)
      expect(child.frontmatter.notion_md.page_id).toBe(thirdPageId)
    })
  })

  it('workspace sync does not assign a new child page to an existing manifest path', async () => {
    await withTempDir(async (dir) => {
      const thirdPageId = '00000000-0000-4000-8000-000000000041'
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Root',
          markdown: '# Root\n\nBody',
          childPageIds: [secondPageId],
        },
        { pageId: secondPageId, title: 'Plan', markdown: '# Plan\n\nExisting body' },
        { pageId: thirdPageId, title: 'Plan', markdown: '# Plan\n\nNew body' },
      ])

      await runWithFake(syncRemoteToTarget({ pageId, target: dir }), fake)
      fake.setChildPages(pageId, [thirdPageId, secondPageId])

      const result = await runWithFake(syncWorkspace({ root: dir }), fake)
      const manifest = JSON.parse(await readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8'))

      expect(result.materialized.map((item) => item.pageId)).toContain(thirdPageId)
      expect(manifest.pages[secondPageId]).toBe('plan.nmd')
      expect(manifest.pages[thirdPageId]).toBe('plan-000041.nmd')
    })
  })

  it('workspace sync rejects malformed manifests instead of recreating them', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Root', markdown: '# Root\n\nBody' }])
      const manifestPath = join(dir, '.notion-md', 'workspace.json')
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, '{ "version": 1, "pages": {} }\n')

      await expect(
        runWithFake(syncWorkspace({ root: dir, rootPageId: pageId }), fake),
      ).rejects.toThrow('Invalid notion-md workspace manifest')
      expect(await readFile(manifestPath, 'utf8')).toBe('{ "version": 1, "pages": {} }\n')
    })
  })

  it('workspace sync rejects manifest paths outside the workspace root', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Root', markdown: '# Root\n\nBody' }])
      const manifestPath = join(dir, '.notion-md', 'workspace.json')
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            version: 1,
            root_page_id: pageId,
            pages: { [pageId]: '../outside.nmd' },
          },
          null,
          2,
        ),
      )

      await expect(runWithFake(statusWorkspace({ root: dir }), fake)).rejects.toThrow(
        'escapes the workspace root',
      )
    })
  })

  it('workspace establishment refuses to overwrite existing planned page paths', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Root', markdown: '# Root\n\nBody' }])
      await writeFile(join(dir, 'index.nmd'), 'local notes\n')

      await expect(runWithFake(syncRemoteToTarget({ pageId, target: dir }), fake)).rejects.toThrow(
        'planned page path',
      )
      await expect(readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8')).rejects.toThrow()
    })
  })

  it('workspace status reports missing remote child pages without materializing them', async () => {
    await withTempDir(async (dir) => {
      const thirdPageId = '00000000-0000-4000-8000-000000000031'
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Root',
          markdown: '# Root\n\nBody',
          childPageIds: [secondPageId],
        },
        { pageId: secondPageId, title: 'First Child', markdown: '# First Child\n\nBody' },
        { pageId: thirdPageId, title: 'Second Child', markdown: '# Second Child\n\nBody' },
      ])

      await runWithFake(syncRemoteToTarget({ pageId, target: dir }), fake)
      fake.setChildPages(pageId, [secondPageId, thirdPageId])

      const result = await runWithFake(statusWorkspace({ root: dir }), fake)

      expect(result.missing).toEqual([{ pageId: thirdPageId, path: 'second-child.nmd' }])
      await expect(readFile(join(dir, 'second-child.nmd'), 'utf8')).rejects.toThrow()
    })
  })

  it('batch sync reconciles independent local and remote edits across files', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        { pageId, title: 'Local', markdown: '# Local\n\nBody' },
        { pageId: secondPageId, title: 'Remote', markdown: '# Remote\n\nBody' },
      ])
      const localPath = join(dir, 'local.nmd')
      const remotePath = join(dir, 'nested', 'remote.nmd')

      await runWithFake(pullPage({ pageId, outPath: localPath }), fake)
      await runWithFake(pullPage({ pageId: secondPageId, outPath: remotePath }), fake)
      await writeFile(localPath, (await readFile(localPath, 'utf8')).replace('Body', 'Local body'))
      fake.mutateRemote(secondPageId, '# Remote\n\nRemote body')

      const batch = await runWithFake(
        syncMany({ targets: [localPath, remotePath], concurrency: 2 }),
        fake,
      )
      const localStatus = await runWithFake(statusPage({ path: localPath }), fake)
      const remoteStatus = await runWithFake(statusPage({ path: remotePath }), fake)
      const remoteParsed = await parseFile(remotePath)

      expect(batch).toMatchObject({
        _tag: 'batch',
        operation: 'sync',
        total: 2,
        succeeded: 2,
        failed: 0,
      })
      expect(batch.items).toContainEqual(
        expect.objectContaining({
          _tag: 'success',
          path: localPath,
          result: expect.objectContaining({ _tag: 'pushed' }),
        }),
      )
      expect(batch.items).toContainEqual(
        expect.objectContaining({
          _tag: 'success',
          path: remotePath,
          result: expect.objectContaining({ _tag: 'pulled' }),
        }),
      )
      expect(fake.remoteMarkdown(pageId)).toContain('Local body')
      expect(remoteParsed.body).toContain('Remote body')
      expect(localStatus.remoteChanged).toBe(false)
      expect(remoteStatus.remoteChanged).toBe(false)
    })
  })

  it('batch sync rejects duplicate page ids before mutating either file', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Duplicate', markdown: '# Duplicate\n\nBody' }])
      const firstPath = join(dir, 'first.nmd')
      const secondPath = join(dir, 'second.nmd')

      await runWithFake(pullPage({ pageId, outPath: firstPath }), fake)
      await writeFile(secondPath, await readFile(firstPath, 'utf8'))
      await writeFile(
        firstPath,
        (await readFile(firstPath, 'utf8')).replace('Body', 'First local body'),
      )
      await writeFile(
        secondPath,
        (await readFile(secondPath, 'utf8')).replace('Body', 'Second local body'),
      )

      const batch = await runWithFake(
        syncMany({ targets: [firstPath, secondPath], concurrency: 2 }),
        fake,
      )

      expect(batch).toMatchObject({
        _tag: 'batch',
        operation: 'sync',
        total: 2,
        succeeded: 0,
        failed: 2,
      })
      expect(fake.updateMarkdownCalls).toEqual([])
      expect(fake.remoteMarkdown(pageId)).toContain('Body')
      expect(batch.items).toEqual([
        expect.objectContaining({ _tag: 'error', path: firstPath }),
        expect.objectContaining({ _tag: 'error', path: secondPath }),
      ])
    })
  })

  it('recursive target discovery finds nested .nmd files and ignores .notion-md objects', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        { pageId, title: 'Root', markdown: '# Root\n\nBody' },
        { pageId: secondPageId, title: 'Nested', markdown: '# Nested\n\nBody' },
      ])
      const rootPath = join(dir, 'root.nmd')
      const nestedPath = join(dir, 'docs', 'nested.nmd')
      const ignoredDir = join(dir, '.notion-md')
      const ignoredPath = join(ignoredDir, 'ignored.nmd')

      await runWithFake(pullPage({ pageId, outPath: rootPath }), fake)
      await runWithFake(pullPage({ pageId: secondPageId, outPath: nestedPath }), fake)
      await mkdir(ignoredDir, { recursive: true })
      await writeFile(ignoredPath, 'not a real nmd')

      const resolved = await runWithFake(
        resolveNmdTargets({ targets: [dir], recursive: true, operation: 'status' }),
        fake,
      )

      expect(resolved.errors).toEqual([])
      expect(resolved.paths).toEqual([nestedPath, rootPath].toSorted())
    })
  })

  it('batch watch coalesces multiple files into batch sync passes', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        { pageId, title: 'Local', markdown: '# Local\n\nBody' },
        { pageId: secondPageId, title: 'Remote', markdown: '# Remote\n\nBody' },
      ])
      const localPath = join(dir, 'local.nmd')
      const remotePath = join(dir, 'remote.nmd')
      const events: unknown[] = []

      await runWithFake(pullPage({ pageId, outPath: localPath }), fake)
      await runWithFake(pullPage({ pageId: secondPageId, outPath: remotePath }), fake)
      await writeFile(
        localPath,
        (await readFile(localPath, 'utf8')).replace('Body', 'Watched local body'),
      )
      fake.mutateRemote(secondPageId, '# Remote\n\nWatched remote body')

      await runWithFake(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(
              runBatchWatch({
                paths: [localPath, remotePath],
                pollIntervalMs: 50,
                concurrency: 2,
                emit: (event) =>
                  Effect.sync(() => {
                    events.push(event)
                  }),
              }),
            )
            yield* Effect.sleep('700 millis')
            yield* Fiber.interrupt(fiber)
          }),
        ),
        fake,
      )

      expect(fake.remoteMarkdown(pageId)).toContain('Watched local body')
      expect((await parseFile(remotePath)).body).toContain('Watched remote body')
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'sync',
          result: expect.objectContaining({
            _tag: 'batch',
            succeeded: 2,
          }),
        }),
      )
    })
  })

  it('auto-merges non-overlapping local and remote body edits from the base snapshot', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nLine A\nLine B',
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Line A', 'Local line A'))
      fake.mutateRemote(pageId, '# Probe\n\nLine A\nRemote line B')

      const pushed = await runWithFake(pushPage({ path }), fake)
      const status = await runWithFake(statusPage({ path }), fake)
      const base = await readBaseSnapshotFile(path)

      expect(pushed.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toContain('Local line A')
      expect(fake.remoteMarkdown(pageId)).toContain('Remote line B')
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
      expect(base.body).toContain('Local line A')
      expect(base.body).toContain('Remote line B')
    })
  })

  it('auto-merges non-overlapping local insertions and remote deletions from the base snapshot', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nKeep\nDelete remotely\nTail',
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Keep', 'Local intro\nKeep'))
      fake.mutateRemote(pageId, '# Probe\n\nKeep\nTail')

      const pushed = await runWithFake(pushPage({ path }), fake)
      const remote = fake.remoteMarkdown(pageId)

      expect(pushed.pushed).toBe(true)
      expect(remote).toContain('Local intro')
      expect(remote).toContain('Keep')
      expect(remote).toContain('Tail')
      expect(remote).not.toContain('Delete remotely')
    })
  })

  it('refuses to overwrite a remote edit unless force is explicit', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')

      await expect(runWithFake(pushPage({ path }), fake)).rejects.toThrow(
        'Remote page changed since the last clean pull',
      )
      const conflict = await readFile(`${path}.conflict.roughdraft.md`, 'utf8')
      expect(conflict).toContain('{==Body conflict==}')
      expect(conflict).toContain('## Base body')
      expect(conflict).toContain('Body')
      expect(conflict).toContain('Local body')
      expect(conflict).toContain('Remote body')

      const forced = await runWithFake(pushPage({ path, force: true }), fake)
      expect(forced.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toContain('Local body')
    })
  })

  it('refuses to push unresolved Roughdraft review markup by default', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', '{==Body==}{>>Needs review.<<}{id="c1"}'))

      await expect(runWithFake(pushPage({ path }), fake)).rejects.toThrow(
        'Local body contains unresolved Roughdraft review markup',
      )

      const allowed = await runWithFake(pushPage({ path, allowReviewMarkup: true }), fake)
      expect(allowed.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toContain('{==Body==}')
    })
  })

  it('pushes explicit typed frontmatter property edits through the page property API', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Done: { _tag: 'checkbox', value: true },
              },
            },
          },
          body: parsed.body,
        }),
      )

      const pushed = await runWithFake(pushPage({ path }), fake)
      const refreshedSync = await readSyncStateFile(path)

      expect(pushed.pushed).toBe(true)
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
      expect(refreshedSync.read_only_properties.Done).toEqual({
        property_type: 'unknown',
        value: { checkbox: true },
      })
    })
  })

  it('refuses to refresh a property-only push over a concurrent local body edit', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      const propertyOnlyContent = renderNmdFile({
        frontmatter: {
          notion_md: {
            ...parsed.frontmatter.notion_md,
            properties: {
              ...parsed.frontmatter.notion_md.properties,
              Done: { _tag: 'checkbox', value: true },
            },
          },
        },
        body: parsed.body,
      })
      await writeFile(path, propertyOnlyContent)
      fake.runAfterNextPropertyUpdate(() => {
        writeFileSync(path, propertyOnlyContent.replace('Body', 'Concurrent local body'))
      })

      await expect(runWithFake(pushPage({ path }), fake)).rejects.toThrow(
        'Local .nmd body changed while push was in progress',
      )
      const after = await parseFile(path)

      expect(after.body).toContain('Concurrent local body')
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
    })
  })

  it('refuses to silently drop unsupported file property values during push', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                Attachment: {
                  _tag: 'files',
                  value: [{ _tag: 'local_file', path: 'attachments/hero.png' }],
                },
              },
            },
          },
          body: parsed.body,
        }),
      )

      await expect(runWithFake(pushPage({ path }), fake)).rejects.toThrow(
        'file upload is not implemented',
      )
    })
  })

  it('pushes explicit frontmatter page metadata edits through the page metadata API', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          icon: { type: 'icon', icon: { name: 'flask', color: 'gray' } },
          cover: null,
          inTrash: false,
          isLocked: false,
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              page: {
                ...parsed.frontmatter.notion_md.page,
                icon: { type: 'icon', icon: { name: 'lock', color: 'gray' } },
                cover: {
                  type: 'external',
                  external: { url: 'https://example.com/notion-md-cover.png' },
                },
                in_trash: true,
                is_locked: true,
              },
            },
          },
          body: parsed.body,
        }),
      )

      const beforePushStatus = await runWithFake(statusPage({ path }), fake)
      const pushed = await runWithFake(pushPage({ path }), fake)
      const refreshed = await parseFile(path)

      expect(beforePushStatus.localPageMetadataChanged).toBe(true)
      expect(pushed.pushed).toBe(true)
      expect(fake.remoteMetadata(pageId)).toMatchObject({
        icon: { type: 'icon', icon: { name: 'lock', color: 'gray' } },
        cover: {
          type: 'external',
          external: { url: 'https://example.com/notion-md-cover.png' },
        },
        in_trash: true,
        is_locked: true,
      })
      expect(refreshed.frontmatter.notion_md.page.icon).toEqual({
        type: 'icon',
        icon: { name: 'lock', color: 'gray' },
      })
      expect(refreshed.frontmatter.notion_md.page.cover).toEqual({
        type: 'external',
        external: { url: 'https://example.com/notion-md-cover.png' },
      })
      expect(refreshed.frontmatter.notion_md.page.in_trash).toBe(true)
      expect(refreshed.frontmatter.notion_md.page.is_locked).toBe(true)
    })
  })

  it('pushes a renamed page title through the page metadata API', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Original Title',
          markdown: '# Original Title\n\nBody',
          inTrash: false,
          isLocked: false,
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              page: {
                ...parsed.frontmatter.notion_md.page,
                title: 'New Title',
              },
            },
          },
          body: parsed.body,
        }),
      )

      const beforePushStatus = await runWithFake(statusPage({ path }), fake)
      const pushed = await runWithFake(pushPage({ path }), fake)
      const refreshed = await parseFile(path)

      expect(beforePushStatus.localPageMetadataChanged).toBe(true)
      expect(pushed.pushed).toBe(true)
      expect(fake.remoteMetadata(pageId).title).toBe('New Title')
      expect(refreshed.frontmatter.notion_md.page.title).toBe('New Title')
    })
  })

  it('pushes newer typed place and verification property values from frontmatter', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: {
            Place: { type: 'place', place: null },
            Verification: { type: 'verification', verification: { state: 'unverified' } },
          },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Place: {
                  _tag: 'place',
                  value: {
                    lat: 47.3769,
                    lon: 8.5417,
                    name: 'Zurich',
                    address: 'Zurich, Switzerland',
                  },
                },
                Verification: {
                  _tag: 'verification',
                  value: {
                    state: 'verified',
                    date: { start: '2026-05-23', end: null, time_zone: null },
                  },
                },
              },
            },
          },
          body: parsed.body,
        }),
      )

      const pushed = await runWithFake(pushPage({ path }), fake)

      expect(pushed.pushed).toBe(true)
      expect(fake.remoteProperties(pageId).Place).toEqual({
        place: {
          lat: 47.3769,
          lon: 8.5417,
          name: 'Zurich',
          address: 'Zurich, Switzerland',
        },
      })
      expect(fake.remoteProperties(pageId).Verification).toEqual({
        verification: {
          state: 'verified',
          date: { start: '2026-05-23', end: null, time_zone: null },
        },
      })
    })
  })

  it('does not treat remote metadata-only edits as body conflicts', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      fake.touchRemoteMetadata(pageId)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Done: { _tag: 'checkbox', value: true },
              },
            },
          },
          body: parsed.body,
        }),
      )

      const beforePushStatus = await runWithFake(statusPage({ path }), fake)
      const pushed = await runWithFake(pushPage({ path }), fake)

      expect(beforePushStatus.remoteChanged).toBe(true)
      expect(beforePushStatus.remoteBodyChanged).toBe(false)
      expect(beforePushStatus.remotePageMetadataChanged).toBe(true)
      expect(pushed.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toBe('# Probe\n\nBody')
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
    })
  })

  it('pushes property-only edits when the remote body changed concurrently', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Done: { _tag: 'checkbox', value: true },
              },
            },
          },
          body: parsed.body,
        }),
      )

      const beforePushStatus = await runWithFake(statusPage({ path }), fake)
      const pushed = await runWithFake(pushPage({ path }), fake)
      const afterPushStatus = await runWithFake(statusPage({ path }), fake)
      const refreshed = await parseFile(path)

      expect(beforePushStatus.localChanged).toBe(false)
      expect(beforePushStatus.localPropertiesChanged).toBe(true)
      expect(beforePushStatus.remoteBodyChanged).toBe(true)
      expect(pushed.pushed).toBe(true)
      expect(fake.updateMarkdownCalls).toEqual([])
      expect(fake.remoteMarkdown(pageId)).toBe('# Probe\n\nRemote body\n')
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
      expect(refreshed.body).toBe('# Probe\n\nRemote body\n')
      expect(afterPushStatus.localChanged).toBe(false)
      expect(afterPushStatus.remoteChanged).toBe(false)
    })
  })

  it('keeps compact unsupported blocks, file units, and comment bridge metadata self-contained', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Unknowns',
          markdown: '# Unknowns\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
          storage: unsupportedStorage(),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'unknowns.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const syncState = await readSyncStateFile(path)

      expect(syncState.storage._tag).toBe('self_contained')
      if (syncState.storage._tag === 'self_contained') {
        expect(syncState.storage.unsupported_blocks).toHaveLength(1)
        expect(syncState.storage.files).toHaveLength(1)
        expect(syncState.storage.comments).toHaveLength(1)
      }
      expect(syncState.body.unknown_block_ids).toEqual([blockId])
    })
  })

  it('refuses to push local edits when unresolved unknown blocks could be deleted', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Unknowns',
          markdown: '# Unknowns\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
          storage: unsupportedStorage(),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'unknowns.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('# Unknowns', '# Unknowns\n\nLocal edit'))

      await expect(runWithFake(pushPage({ path }), fake)).rejects.toThrow(
        'Page contains unresolved unknown Notion blocks',
      )
      expect(fake.remoteMarkdown(pageId)).toContain('<unknown')

      const destructive = await runWithFake(
        pushPage({ path, allowDeletingUnknownBlocks: true }),
        fake,
      )
      expect(destructive.pushed).toBe(true)
      expect(fake.updateMarkdownCalls.at(-1)).toEqual({
        pageId,
        allowDeletingContent: true,
        command: 'replace_content',
        markdown:
          '# Unknowns\n\nLocal edit\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>\n',
      })
      expect(fake.remoteMarkdown(pageId)).toContain('Local edit')
    })
  })

  it('clears stale unknown-block storage after an explicit destructive body replacement', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Unknowns',
          markdown: '# Unknowns\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
          storage: unsupportedStorage(),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'unknowns.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(
        path,
        content.replace(
          '\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
          '\n\nReplacement body',
        ),
      )

      const pushed = await runWithFake(pushPage({ path, allowDeletingUnknownBlocks: true }), fake)
      const syncState = await readSyncStateFile(path)
      const status = await runWithFake(statusPage({ path }), fake)

      expect(pushed.pushed).toBe(true)
      expect(syncState.storage).toMatchObject({
        _tag: 'self_contained',
        unsupported_blocks: [],
        files: [],
        comments: [],
      })
      expect(syncState.body.unknown_block_ids).toEqual([])
      expect(status.unresolvedUnknownBlocks).toEqual([])
      expect(status.localChanged).toBe(false)
      expect(status.remoteChanged).toBe(false)
    })
  })

  it('escalates volatile retrieval URLs to an object store instead of embedding them in frontmatter', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Volatile',
          markdown: '# Volatile',
          storage: unsupportedStorage({
            url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=abc',
          }),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'volatile.nmd')

      const result = await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const syncState = await readSyncStateFile(path)

      expect(result.storage).toBe('object_store')
      expect(syncState.storage).toMatchObject({
        _tag: 'object_store',
        unsupported_block_ids: [blockId],
      })
    })
  })

  it('uses targeted Markdown updates for clean-base local body edits', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))

      await runWithFake(pushPage({ path }), fake)

      expect(fake.updateMarkdownCalls).toEqual([
        {
          pageId,
          allowDeletingContent: false,
          command: 'update_content',
          markdown: '# Probe\n\nLocal body\n',
        },
      ])
    })
  })

  it('does not send Markdown updates for property-only pushes', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Done: { _tag: 'checkbox', value: true },
              },
            },
          },
          body: parsed.body,
        }),
      )

      await runWithFake(pushPage({ path }), fake)

      expect(fake.updateMarkdownCalls).toEqual([])
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
    })
  })

  it('refreshes the local body from Notion after a property-only push race', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Done: { type: 'checkbox', checkbox: false } },
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              properties: {
                ...parsed.frontmatter.notion_md.properties,
                Done: { _tag: 'checkbox', value: true },
              },
            },
          },
          body: parsed.body,
        }),
      )
      fake.mutateRemoteAfterNextPropertyUpdate(pageId, '# Probe\n\nRemote race body')

      const beforePushStatus = await runWithFake(statusPage({ path }), fake)
      const pushed = await runWithFake(pushPage({ path }), fake)
      const afterPushStatus = await runWithFake(statusPage({ path }), fake)
      const refreshed = await parseFile(path)

      expect(beforePushStatus.localChanged).toBe(false)
      expect(beforePushStatus.remoteBodyChanged).toBe(false)
      expect(pushed.pushed).toBe(true)
      expect(fake.updateMarkdownCalls).toEqual([])
      expect(fake.remoteMarkdown(pageId)).toBe('# Probe\n\nRemote race body\n')
      expect(refreshed.body).toBe('# Probe\n\nRemote race body\n')
      expect(afterPushStatus.localChanged).toBe(false)
      expect(afterPushStatus.remoteChanged).toBe(false)
    })
  })

  it('falls back to guarded replace_content when a local hunk is ambiguous', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        { pageId, title: 'Probe', markdown: '# Probe\n\nRepeat\nRepeat' },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Repeat\nRepeat', 'Repeat\nChanged repeat'))

      await runWithFake(pushPage({ path }), fake)

      expect(fake.updateMarkdownCalls).toEqual([
        {
          pageId,
          allowDeletingContent: false,
          command: 'replace_content',
          markdown: '# Probe\n\nRepeat\nChanged repeat\n',
        },
      ])
    })
  })

  it('writes a typed conflict error for overlapping body edits', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nLine A\nLine B',
        },
      ])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Line A', 'Local line A'))
      fake.mutateRemote(pageId, '# Probe\n\nRemote line A\nLine B')

      const result = await runEitherWithFake(pushPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdConflictError',
          path,
          page_id: pageId,
          local_changed: true,
          remote_changed: true,
          conflict_path: `${path}.conflict.roughdraft.md`,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected pushPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdConflictError)
    })
  })

  it('rejects corrupted content-addressed base snapshots before merging', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')
      const basePath = await baseSnapshotObjectPath(path)
      await writeFile(
        basePath,
        `${JSON.stringify(
          {
            version: 2,
            page_id: pageId,
            body_hash: `sha256:${'a'.repeat(64)}`,
            body: '# Probe\n\nTampered body\n',
          },
          null,
          2,
        )}\n`,
      )

      const result = await runEitherWithFake(pushPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
          object_path: basePath,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected pushPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })

  it('rejects trailing-byte mutations in content-addressed objects', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const basePath = await baseSnapshotObjectPath(path)
      await writeFile(basePath, `${await readFile(basePath, 'utf8')} `)

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
          object_path: basePath,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })

  it('rejects legacy sidecar references as typed frontmatter errors instead of migrating them', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Volatile',
          markdown: '# Volatile',
          storage: unsupportedStorage({
            url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=abc',
          }),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'volatile.nmd')
      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)

      await writeFile(
        path,
        `---\n${JSON.stringify(
          {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              storage: {
                _tag: 'sidecar',
                path: 'volatile.nmd.notion.json',
                unsupported_block_ids: [blockId],
                file_ids: ['hero-image'],
                comment_ids: ['roughdraft-1'],
              },
            },
          },
          null,
          2,
        )}\n---\n\n${parsed.body}`,
      )

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdFrontmatterError',
          path,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdFrontmatterError)
    })
  })

  it('fails loudly when the sidecar is missing for a materialized page', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      /*
       * Simulate a fresh-clone-of-gitignored-`.notion-md/` scenario by
       * wiping the sidecar. With a materialized `.nmd` (page_id set) the
       * engine must refuse to operate rather than silently treat the
       * local body as a baseline — that path produced silent no-op
       * pushes in the original §6 implementation.
       */
      await rm(join(dir, '.notion-md'), { recursive: true, force: true })

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdFrontmatterError',
          path,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left.message).toContain('Missing sidecar sync state')
      expect(result.left.message).toContain(pageId)
    })
  })

  it('keeps derived sync state in the sidecar, not the frontmatter', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Probe',
          markdown: '# Probe\n\nBody',
          properties: { Status: { type: 'select', select: { name: 'Ready' } } },
        },
      ])
      const path = join(dir, 'probe.nmd')
      await runWithFake(pullPage({ pageId, outPath: path }), fake)

      /*
       * Shape contract for the V2 split: derived bookkeeping must live in
       * the sidecar (`.notion-md/sync/{page_id}.json`), the on-disk `.nmd`
       * must only carry user-facing state. Anything we accidentally
       * resurrect on the frontmatter side defeats the §6 design goal.
       */
      const parsed = await parseFile(path)
      const frontmatter = parsed.frontmatter.notion_md as Record<string, unknown>
      expect(frontmatter.body).toBeUndefined()
      expect(frontmatter.storage).toBeUndefined()
      expect(frontmatter.data_source).toBeUndefined()
      expect(frontmatter.version).toBe(2)

      const syncState = await readSyncStateFile(path)
      expect(syncState.body.hash).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(syncState.storage._tag).toBe('self_contained')
      expect(syncState.read_only_properties.Status).toEqual({
        property_type: 'select',
        value: { type: 'select', select: { name: 'Ready' } },
      })
    })
  })

  it('rejects unknown frontmatter versions instead of silently migrating state stores', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')
      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const parsed = await parseFile(path)

      await writeFile(
        path,
        `---\n${JSON.stringify(
          {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              version: 99,
            },
          },
          null,
          2,
        )}\n---\n\n${parsed.body}`,
      )

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdFrontmatterError',
          path,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdFrontmatterError)
    })
  })

  it('rejects tampered object-store storage payloads before status can pass', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Volatile',
          markdown: '# Volatile',
          storage: unsupportedStorage({
            url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=abc',
          }),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'volatile.nmd')
      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const syncState = await readSyncStateFile(path)
      if (syncState.storage._tag !== 'object_store') {
        throw new Error('Expected volatile payload to be stored in the object store')
      }
      const storagePath = objectPath({
        path,
        hash: syncState.storage.object.hash,
      })
      await writeFile(
        storagePath,
        '{"version":2,"page_id":"tampered","reason":"volatile_url","storage":{"_tag":"self_contained","unsupported_blocks":[],"files":[],"comments":[]}}\n',
      )

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
          object_path: storagePath,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })

  it('rejects object-store inventory mismatches between frontmatter and payload', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Volatile',
          markdown: '# Volatile',
          storage: unsupportedStorage({
            url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=abc',
          }),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'volatile.nmd')
      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const syncState = await readSyncStateFile(path)
      if (syncState.storage._tag !== 'object_store') {
        throw new Error('Expected volatile payload to be stored in the object store')
      }

      /*
       * Tamper the sidecar inventory directly — the engine validates it
       * against the storage payload before status can pass.
       */
      const sidecarRoot = path.slice(0, Math.max(0, path.length - 'volatile.nmd'.length))
      const sidecarPath = `${sidecarRoot}.notion-md/sync/${pageId}.json`
      await writeFile(
        sidecarPath,
        JSON.stringify(
          {
            ...syncState,
            storage: {
              ...syncState.storage,
              unsupported_block_ids: [],
            },
          },
          null,
          2,
        ) + '\n',
      )

      const result = await runEitherWithFake(statusPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected statusPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })

  it('rejects v1 base snapshot objects instead of migrating them', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')
      const syncState = await readSyncStateFile(path)
      const base = await readBaseSnapshotFile(path)
      const legacyBaseContent = JSON.stringify({ ...base, version: 1 }, null, 2)
      const legacyHash = sha256Digest(legacyBaseContent)
      const legacyPath = objectPath({ path, hash: legacyHash })
      await mkdir(dirname(legacyPath), { recursive: true })
      await writeFile(legacyPath, `${legacyBaseContent}\n`)
      /*
       * Point the sidecar at the legacy v1 base snapshot blob; the engine
       * must reject it (no silent migration of content-addressed objects).
       */
      const sidecarRoot = path.slice(0, Math.max(0, path.length - 'probe.nmd'.length))
      const sidecarPath = `${sidecarRoot}.notion-md/sync/${pageId}.json`
      await writeFile(
        sidecarPath,
        JSON.stringify(
          {
            ...syncState,
            body: {
              ...syncState.body,
              base: {
                _tag: 'object_ref',
                role: 'base_snapshot',
                hash: legacyHash,
                path: objectRelativePath(legacyHash),
                media_type: 'application/json',
                byte_length: new TextEncoder().encode(legacyBaseContent).byteLength,
              },
            },
          },
          null,
          2,
        ) + '\n',
      )

      const result = await runEitherWithFake(pushPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
          object_path: objectPath({ path, hash: legacyHash }),
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected pushPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })
})
