import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Fiber, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdStorage } from '@overeng/notion-effect-client'

import { runWatch } from './cli-program.ts'
import { NmdConflictError, NmdFrontmatterError, NmdObjectStoreError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { canonicalizeMarkdown, sha256Digest } from './hash.ts'
import { NotionMdGateway, type MarkdownUpdateCommand, type PullPageResult } from './model.ts'
import {
  NmdStateStoreLive,
  objectPath,
  objectRelativePath,
  type NmdStateStore,
} from './state-store.ts'
import { pullPage, pushPage, statusPage, syncPage } from './sync.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const blockId = '00000000-0000-4000-8000-000000000002'
const fileBlockId = '00000000-0000-4000-8000-000000000003'
const hash = `sha256:${'a'.repeat(64)}` as const

interface FakePage {
  readonly pageId: string
  readonly title: string
  readonly markdown: string
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
                if (update.replaceAllMatches === true) {
                  return body.replaceAll(update.oldStr, update.newStr)
                }
                return body.replace(update.oldStr, update.newStr)
              }, page.markdown)
        this.updateMarkdownCalls.push({
          pageId: id,
          allowDeletingContent,
          command: command._tag,
          markdown: canonicalizeMarkdown(markdown),
        })
        this.tick += 1
        const next = {
          ...page,
          markdown: canonicalizeMarkdown(markdown),
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
        return this.toPullResult(next).page
      }),
  })

  mutateRemote(pageIdToMutate: string, markdown: string): void {
    const page = this.requirePage(pageIdToMutate)
    this.tick += 1
    this.pages.set(pageIdToMutate, {
      ...page,
      markdown: canonicalizeMarkdown(markdown),
      lastEditedTime: `2026-05-22T12:00:0${this.tick}.000Z`,
    })
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

  remoteMarkdown(pageIdToRead: string): string {
    return this.requirePage(pageIdToRead).markdown
  }

  remoteProperties(pageIdToRead: string): Record<string, unknown> {
    return this.requirePage(pageIdToRead).properties
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
        url: `https://www.notion.so/${page.pageId.replaceAll('-', '')}`,
        parent: { type: 'page_id', page_id: pageId },
        icon: null,
        cover: null,
        in_trash: false,
        is_locked: false,
        last_edited_time: page.lastEditedTime,
        properties: page.properties,
      },
      markdown: {
        markdown: canonicalizeMarkdown(page.markdown),
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
  effect: Effect.Effect<A, unknown, NotionMdGateway | NmdStateStore>,
  fake: FakeNotion,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer))))

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

const baseSnapshotObjectPath = async (path: string): Promise<string> => {
  const parsed = await parseFile(path)
  return objectPath({ path, hash: parsed.frontmatter.notion_md.body.base.hash })
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
      const parsed = await parseFile(path)
      const status = await runWithFake(statusPage({ path }), fake)
      const base = await readBaseSnapshotFile(path)

      expect(pull.storage).toBe('self_contained')
      expect(base).toMatchObject({
        version: 2,
        page_id: pageId,
        body: '# Probe\n\nBody\n',
      })
      expect(parsed.frontmatter.notion_md.storage._tag).toBe('self_contained')
      expect(parsed.frontmatter.notion_md.properties.Status).toEqual({
        _tag: 'read_only',
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
            yield* Effect.sleep('700 millis')
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
      const refreshed = await parseFile(path)

      expect(pushed.pushed).toBe(true)
      expect(fake.remoteProperties(pageId).Done).toEqual({ checkbox: true })
      expect(refreshed.frontmatter.notion_md.properties.Done).toEqual({
        _tag: 'read_only',
        property_type: 'unknown',
        value: { checkbox: true },
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
      const parsed = await parseFile(path)

      expect(parsed.frontmatter.notion_md.storage._tag).toBe('self_contained')
      if (parsed.frontmatter.notion_md.storage._tag === 'self_contained') {
        expect(parsed.frontmatter.notion_md.storage.unsupported_blocks).toHaveLength(1)
        expect(parsed.frontmatter.notion_md.storage.files).toHaveLength(1)
        expect(parsed.frontmatter.notion_md.storage.comments).toHaveLength(1)
      }
      expect(parsed.frontmatter.notion_md.body.unknown_block_ids).toEqual([blockId])
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
      const parsed = await parseFile(path)

      expect(result.storage).toBe('object_store')
      expect(parsed.frontmatter.notion_md.storage).toMatchObject({
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

  it('rejects v2 frontmatter instead of silently migrating state stores', async () => {
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
              version: 2,
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
      const parsed = await parseFile(path)
      if (parsed.frontmatter.notion_md.storage._tag !== 'object_store') {
        throw new Error('Expected volatile payload to be stored in the object store')
      }
      const storagePath = objectPath({
        path,
        hash: parsed.frontmatter.notion_md.storage.object.hash,
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

  it('rejects v1 base snapshot objects instead of migrating them', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([{ pageId, title: 'Probe', markdown: '# Probe\n\nBody' }])
      const path = join(dir, 'probe.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))
      fake.mutateRemote(pageId, '# Probe\n\nRemote body')
      const parsed = await parseFile(path)
      const base = await readBaseSnapshotFile(path)
      const legacyBaseContent = JSON.stringify({ ...base, version: 1 }, null, 2)
      const legacyHash = sha256Digest(legacyBaseContent)
      const legacyPath = objectPath({ path, hash: legacyHash })
      await mkdir(dirname(legacyPath), { recursive: true })
      await writeFile(legacyPath, `${legacyBaseContent}\n`)
      await writeFile(
        path,
        renderNmdFile({
          frontmatter: {
            notion_md: {
              ...parsed.frontmatter.notion_md,
              body: {
                ...parsed.frontmatter.notion_md.body,
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
          },
          body: parsed.body,
        }),
      )

      const result = await runEitherWithFake(pushPage({ path }), fake)

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'NmdObjectStoreError',
          path,
          object_path: objectRelativePath(legacyHash),
        },
      })
      if (result._tag !== 'Left') {
        throw new Error('Expected pushPage to fail')
      }
      expect(result.left).toBeInstanceOf(NmdObjectStoreError)
    })
  })
})
