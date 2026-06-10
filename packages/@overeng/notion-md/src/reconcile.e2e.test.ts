import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'

import { canonicalize } from './canonicalizer.ts'
import { renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import { NotionMdGateway, type NotionMdGatewayShape, type PullPageResult } from './model.ts'
import { reconcileFile, statusFile } from './reconcile.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'

/*
 * Control-flow integration tests for the source-aware reconcile engine (R26).
 * The fake gateway exercises the per-page dispatch end-to-end against a real
 * filesystem state store; fidelity (real round-trip shapes) is the golden
 * corpus's job (R35), not this fake's.
 */

const parentId = '00000000-0000-4000-8000-000000000000'
const pageId = '00000000-0000-4000-8000-000000000001'

interface FakePage {
  markdown: string
  title: string
}

class FakeGateway {
  readonly pages = new Map<string, FakePage>()
  private tick = 0

  constructor(seed: ReadonlyArray<readonly [string, FakePage]>) {
    for (const [id, page] of seed) {
      this.pages.set(id, { ...page, markdown: normalizeMarkdownLineEndings(page.markdown) })
    }
    this.pages.set(parentId, { markdown: '\n', title: 'Parent' })
  }

  private require(id: string): FakePage {
    const page = this.pages.get(id)
    if (page === undefined) throw new Error(`unknown fake page ${id}`)
    return page
  }

  private toPull(id: string): PullPageResult {
    const page = this.require(id)
    return {
      page: {
        id,
        title: page.title,
        title_property_key: 'title',
        url: `https://www.notion.so/${id.replaceAll('-', '')}`,
        parent: { type: 'page_id', page_id: parentId },
        icon: null,
        cover: null,
        in_trash: false,
        is_locked: false,
        last_edited_time: '2026-05-22T12:00:00.000Z',
        properties: {},
      },
      markdown: {
        markdown: page.markdown,
        truncated: false,
        unknown_block_ids: [],
        completeness: { _tag: 'complete' },
      },
    }
  }

  mutateRemote(id: string, markdown: string): void {
    this.pages.set(id, { ...this.require(id), markdown: normalizeMarkdownLineEndings(markdown) })
  }

  remoteMarkdown(id: string): string {
    return this.require(id).markdown
  }

  readonly shape: NotionMdGatewayShape = {
    pullPage: ({ pageId: id }) => Effect.sync(() => this.toPull(id)),
    updateMarkdown: ({ pageId: id, command }) =>
      Effect.sync(() => {
        if (command._tag === 'replace_content') this.mutateRemote(id, command.markdown)
        return { markdown: this.toPull(id).markdown }
      }),
    updatePageProperties: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    updatePageMetadata: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    listChildPages: () => Effect.succeed([]),
    createPage: ({ parentPageId, title, markdown }) =>
      Effect.sync(() => {
        this.tick += 1
        const newId = `00000000-0000-4000-8000-0000000${String(this.tick).padStart(5, '0')}`
        this.pages.set(newId, { title, markdown: normalizeMarkdownLineEndings(markdown) })
        void parentPageId
        return this.toPull(newId).page
      }),
    movePage: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    archivePage: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
  }

  get layer() {
    return Layer.succeed(NotionMdGateway, this.shape)
  }
}

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer))

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext | NotionMdGateway | NmdStateStore>,
  fake: FakeGateway,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer, NodeContext.layer))),
  )

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-reconcile-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const frontmatter = (opts: {
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly pageId: string | null
}): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source: opts.source,
    page_id: opts.pageId,
    parent: { _tag: 'page', id: parentId },
    page: { title: 'Doc', icon: null, cover: null, in_trash: false, is_locked: false },
    properties: {},
  },
})

const writeNmd = async (opts: {
  readonly path: string
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly pageId: string | null
  readonly body: string
}): Promise<void> => {
  await writeFile(
    opts.path,
    renderNmdFile({
      frontmatter: frontmatter({ source: opts.source, pageId: opts.pageId }),
      body: opts.body,
    }),
  )
}

describe('reconcileFile — source-aware dispatch (R34)', () => {
  it('source: local, unbound ⇒ creates the remote page and binds page_id', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId: null, body: '# Hello\n\nWorld' })
      const fake = new FakeGateway([])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('created')

      const written = await readFile(path, 'utf8')
      expect(written).toContain('"page_id"')
      // page_id is no longer null
      expect(written).not.toContain('"page_id": null')
    }))

  it('source: local, bound, real change ⇒ pushes (mirror)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Old\n\nold text' }]])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.remoteMarkdown(pageId)).toContain('Local edit')
    }))

  it('source: local, bound, cosmetic-only diff ⇒ noop (#756 churn folded, R33)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      // local uses *emphasis*; remote stored _emphasis_ — semantically equal
      await writeNmd({ path, source: 'local', pageId, body: 'a *word* here' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: 'a _word_ here' }]])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('noop')
    }))

  it('source: remote, remote changed ⇒ pulls (overwrites local body)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: 'stale local' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Fresh remote' }]])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pulled')
      const written = await readFile(path, 'utf8')
      expect(written).toContain('Fresh remote')
    }))

  it('source: remote, equivalent ⇒ noop', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: '# Same' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Same' }]])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('noop')
    }))
})

describe('statusFile — read-only, safe by construction (R30)', () => {
  it('reports git-porcelain words without mutating', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local change' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Remote' }]])
      const before = fake.remoteMarkdown(pageId)

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('local-ahead')
      expect(status.source).toBe('local-bound')
      // status must not have mutated the remote
      expect(fake.remoteMarkdown(pageId)).toBe(before)
    }))

  it('reports unbound for an unbound local file', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId: null, body: '# New' })
      const fake = new FakeGateway([])

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('unbound')
    }))

  it('reports in-sync when local and remote are semantically equal', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: 'x *y* z' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: 'x _y_ z' }]])

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('in-sync')
    }))
})

describe('canonicalize body sent on push', () => {
  it('pushes the canonical form so a re-status reaches noop', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '2. a\n3. b' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: 'unrelated' }]])

      await run(reconcileFile({ path }), fake)
      expect(fake.remoteMarkdown(pageId)).toBe(canonicalize('2. a\n3. b'))

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('in-sync')
    }))
})
