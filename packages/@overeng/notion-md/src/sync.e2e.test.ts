import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdStorage } from '@overeng/notion-effect-client'

import { parseNmdFile } from './frontmatter.ts'
import { canonicalizeMarkdown } from './hash.ts'
import { NotionMdGateway, type PullPageResult } from './model.ts'
import { pullPage, pushPage, statusPage } from './sync.ts'

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
    updateMarkdown: ({ pageId: id, markdown }) =>
      Effect.sync(() => {
        const page = this.requirePage(id)
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

  setStorage(pageIdToMutate: string, storage: NmdStorage): void {
    const page = this.requirePage(pageIdToMutate)
    this.pages.set(pageIdToMutate, { ...page, storage })
  }

  remoteMarkdown(pageIdToRead: string): string {
    return this.requirePage(pageIdToRead).markdown
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

const runWithFake = <A>(effect: Effect.Effect<A, unknown, NotionMdGateway>, fake: FakeNotion) =>
  Effect.runPromise(effect.pipe(Effect.provide(fake.layer)))

const parseFile = async (path: string) => {
  const content = await readFile(path, 'utf8')
  return Effect.runPromise(parseNmdFile({ path, content }))
}

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

      expect(pull.storage).toBe('self_contained')
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

      const forced = await runWithFake(pushPage({ path, force: true }), fake)
      expect(forced.pushed).toBe(true)
      expect(fake.remoteMarkdown(pageId)).toContain('Local body')
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

  it('escalates volatile retrieval URLs to a sidecar instead of embedding them in frontmatter', async () => {
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
      const sidecar = await readFile(join(dir, 'volatile.nmd.notion.json'), 'utf8')

      expect(result.storage).toBe('sidecar')
      expect(parsed.frontmatter.notion_md.storage).toMatchObject({
        _tag: 'sidecar',
        path: 'volatile.nmd.notion.json',
        unsupported_block_ids: [blockId],
      })
      expect(sidecar).toContain('volatile_url')
      expect(sidecar).toContain('X-Amz-Signature')
    })
  })

  it('refreshes sidecar payloads after a successful guarded push', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeNotion([
        {
          pageId,
          title: 'Volatile',
          markdown: '# Volatile\n\nBody',
          storage: unsupportedStorage({
            url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=old',
          }),
          unknownBlockIds: [blockId],
        },
      ])
      const path = join(dir, 'volatile.nmd')

      await runWithFake(pullPage({ pageId, outPath: path }), fake)
      fake.setStorage(
        pageId,
        unsupportedStorage({
          url: 'https://secure.notion-static.com/image.png?X-Amz-Signature=new',
        }),
      )
      const content = await readFile(path, 'utf8')
      await writeFile(path, content.replace('Body', 'Local body'))

      await runWithFake(pushPage({ path }), fake)
      const sidecar = await readFile(join(dir, 'volatile.nmd.notion.json'), 'utf8')

      expect(sidecar).toContain('X-Amz-Signature=new')
      expect(sidecar).not.toContain('X-Amz-Signature=old')
    })
  })

  it('refuses status when a referenced sidecar is missing', async () => {
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
      await rm(join(dir, 'volatile.nmd.notion.json'))

      await expect(runWithFake(statusPage({ path }), fake)).rejects.toThrow(
        'Failed to read .nmd sidecar',
      )
    })
  })
})
