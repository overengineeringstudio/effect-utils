import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'

import { canonicalize } from './canonicalizer.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings } from './hash.ts'
import { NotionMdGateway, type NotionMdGatewayShape, type PullPageResult } from './model.ts'
import { reconcileFile, statusFile, trackPage } from './reconcile.ts'
import { NmdStateStoreLive, syncStatePath, type NmdStateStore } from './state-store.ts'

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
  createCount = 0
  updateCount = 0
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
        this.updateCount += 1
        if (command._tag === 'replace_content') this.mutateRemote(id, command.markdown)
        return { markdown: this.toPull(id).markdown }
      }),
    updatePageProperties: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    updatePageMetadata: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    listChildPages: () => Effect.succeed([]),
    createPage: ({ parentPageId, title, markdown }) =>
      Effect.sync(() => {
        this.createCount += 1
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

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const replaceNmdBody = async (path: string, body: string): Promise<void> => {
  const parsed = await parseNmdFile({ path, content: await readFile(path, 'utf8') }).pipe(
    Effect.runPromise,
  )
  await writeFile(path, renderNmdFile({ frontmatter: parsed.frontmatter, body }))
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

describe('reconcileFile — dry-run planning', () => {
  it('plans track/bootstrap without writing the .nmd file or shared sidecars', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'tracked.nmd')
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Remote' }]])

      const result = await run(
        trackPage({ pageId, outPath: path, source: 'shared', dryRun: true }),
        fake,
      )

      expect(result).toEqual({ path, pageId, source: 'shared', dryRun: true })
      expect(await exists(path)).toBe(false)
      expect(await exists(syncStatePath({ path, pageId }))).toBe(false)
    }))

  it('plans source: local unbound create without creating a remote page or binding the file', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId: null, body: '# Hello\n\nWorld' })
      const before = await readFile(path, 'utf8')
      const fake = new FakeGateway([])

      const result = await run(reconcileFile({ path, dryRun: true }), fake)

      expect(result).toEqual({
        _tag: 'created',
        path,
        pageId: undefined,
        parentPageId: parentId,
        dryRun: true,
      })
      expect(fake.createCount).toBe(0)
      expect(await readFile(path, 'utf8')).toBe(before)
    }))

  it('plans source: local push without mutating the remote page', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Old\n\nold text' }]])

      const result = await run(reconcileFile({ path, dryRun: true }), fake)

      expect(result).toEqual({ _tag: 'pushed', path, pageId, dryRun: true })
      expect(fake.updateCount).toBe(0)
      expect(fake.remoteMarkdown(pageId)).toBe('# Old\n\nold text\n')
    }))

  it('plans source: remote pull without mutating the local .nmd file', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: 'stale local' })
      const before = await readFile(path, 'utf8')
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Fresh remote' }]])

      const result = await run(reconcileFile({ path, dryRun: true }), fake)

      expect(result).toEqual({ _tag: 'pulled', path, pageId, dryRun: true })
      expect(await readFile(path, 'utf8')).toBe(before)
    }))

  it('plans shared merge without mutating Notion, the .nmd file, sidecar, or object store', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: 'alpha\n\nbeta\n\ngamma' }]])
      await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)
      await replaceNmdBody(path, 'alpha local\n\nbeta\n\ngamma')
      fake.mutateRemote(pageId, 'alpha\n\nbeta remote\n\ngamma')
      const beforeFile = await readFile(path, 'utf8')
      const sidecarPath = syncStatePath({ path, pageId })
      const beforeSidecar = await readFile(sidecarPath, 'utf8')
      const beforeRemote = fake.remoteMarkdown(pageId)

      const result = await run(reconcileFile({ path, dryRun: true }), fake)

      expect(result).toEqual({ _tag: 'shared-merged', path, pageId, dryRun: true })
      expect(fake.updateCount).toBe(0)
      expect(fake.remoteMarkdown(pageId)).toBe(beforeRemote)
      expect(await readFile(path, 'utf8')).toBe(beforeFile)
      expect(await readFile(sidecarPath, 'utf8')).toBe(beforeSidecar)
    }))

  it('plans shared conflict without writing a conflict file', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: 'base' }]])
      await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)
      await replaceNmdBody(path, 'local')
      fake.mutateRemote(pageId, 'remote')
      const beforeFile = await readFile(path, 'utf8')
      const sidecarPath = syncStatePath({ path, pageId })
      const beforeSidecar = await readFile(sidecarPath, 'utf8')

      const result = await run(reconcileFile({ path, dryRun: true }), fake)

      expect(result).toEqual({
        _tag: 'shared-conflict',
        path,
        pageId,
        conflictPath: `${path}.conflict.roughdraft.md`,
        dryRun: true,
      })
      expect(fake.updateCount).toBe(0)
      expect(await exists(`${path}.conflict.roughdraft.md`)).toBe(false)
      expect(await readFile(path, 'utf8')).toBe(beforeFile)
      expect(await readFile(sidecarPath, 'utf8')).toBe(beforeSidecar)
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
