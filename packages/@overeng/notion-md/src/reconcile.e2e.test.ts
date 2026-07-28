import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2, NmdStorage } from '@overeng/notion-effect-client'

import { canonicalizeBlockMarkdown } from './canonical-markdown.ts'
import { NmdDestructiveBodyBlockedError } from './errors.ts'
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
const blockId = '00000000-0000-4000-8000-000000000002'
const fileBlockId = '00000000-0000-4000-8000-000000000003'
const hash = `sha256:${'a'.repeat(64)}` as const

const mediaStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
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
  comments: [],
})

const unsupportedStorage = (): NmdStorage => ({
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
        payload: { url: 'https://www.notion.com/' },
      },
    },
  ],
  files: [],
  comments: [],
})

interface FakePage {
  markdown: string
  title: string
  storage?: NmdStorage
  unknownBlockIds?: readonly string[]
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
        truncated: (page.unknownBlockIds ?? []).length > 0,
        unknown_block_ids: page.unknownBlockIds ?? [],
        completeness: { _tag: 'complete' },
      },
      ...(page.storage === undefined ? {} : { storage: page.storage }),
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
    updateMarkdown: ({ pageId: id, command, allowDeletingContent }) =>
      Effect.sync(() => {
        this.updateCount += 1
        if (command._tag === 'replace_content') {
          const page = this.require(id)
          this.pages.set(id, {
            ...page,
            markdown: normalizeMarkdownLineEndings(command.markdown),
            ...(allowDeletingContent === true && command.markdown.includes('<unknown') === false
              ? {
                  storage: {
                    _tag: 'self_contained',
                    unsupported_blocks: [],
                    files: [],
                    comments: [],
                  } satisfies NmdStorage,
                  unknownBlockIds: [],
                }
              : {}),
          })
        }
        return { markdown: this.toPull(id).markdown }
      }),
    updatePageProperties: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    updatePageMetadata: ({ pageId: id }) => Effect.sync(() => this.toPull(id).page),
    retrieveDataSource: ({ dataSourceId }) =>
      Effect.succeed({ id: dataSourceId, databaseId: dataSourceId, properties: {} }),
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

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext | NotionMdGateway | NmdStateStore>,
  fake: FakeGateway,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer, NodeServices.layer))),
  )

/** Runs an effect expected to fail and returns its typed expected error. */
const runFailure = async <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext | NotionMdGateway | NmdStateStore>,
  fake: FakeGateway,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(Layer.mergeAll(fake.layer, stateStoreLayer, NodeServices.layer))),
  )
  if (Exit.isSuccess(exit) === true) throw new Error('expected the effect to fail')
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure) === true) throw new Error('expected an expected failure, got a defect')
  return failure.value
}

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

  it('source: local refuses unresolved Roughdraft review markup unless explicitly allowed', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({
        path,
        source: 'local',
        pageId,
        body: '# Local\n\n{==Body==}{>>Needs review.<<}{id="r1"}',
      })
      const fake = new FakeGateway([[pageId, { title: 'Doc', markdown: '# Old\n\nBody' }]])

      const err = await runFailure(reconcileFile({ path }), fake)
      expect(err).toBeInstanceOf(NmdDestructiveBodyBlockedError)
      expect((err as NmdDestructiveBodyBlockedError).guard).toBe('ReviewMarkupAsContent')
      expect((err as NmdDestructiveBodyBlockedError).allowFlag).toBe('--allow-review-markup')
      expect((err as NmdDestructiveBodyBlockedError).message).toContain(
        'Local body contains unresolved Roughdraft review markup',
      )
      expect(fake.updateCount).toBe(0)

      const result = await run(reconcileFile({ path, allowReviewMarkup: true }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.remoteMarkdown(pageId)).toContain('{==Body==}')
    }))

  it('source: local refuses unknown-block deletion unless explicitly allowed', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local replacement' })
      const fake = new FakeGateway([
        [
          pageId,
          {
            title: 'Doc',
            markdown: '# Remote\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
            storage: unsupportedStorage(),
            unknownBlockIds: [blockId],
          },
        ],
      ])

      const err = await runFailure(reconcileFile({ path }), fake)
      expect(err).toBeInstanceOf(NmdDestructiveBodyBlockedError)
      expect((err as NmdDestructiveBodyBlockedError).guard).toBe('UnknownBlockDeletion')
      expect((err as NmdDestructiveBodyBlockedError).allowFlag).toBe(
        '--allow-delete-unknown-blocks',
      )
      expect((err as NmdDestructiveBodyBlockedError).message).toContain(
        'Page contains unresolved unknown Notion blocks',
      )
      expect(fake.updateCount).toBe(0)

      const result = await run(reconcileFile({ path, allowDeletingUnknownBlocks: true }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.remoteMarkdown(pageId)).toBe('# Local replacement\n')
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

describe('reconcileFile — files/media write boundary (SM6.1)', () => {
  const emptyFilesStorage = (): NmdStorage => ({
    _tag: 'self_contained',
    unsupported_blocks: [],
    files: [],
    comments: [],
  })

  it('blocks a source: local push over byte-backed media with DurableFileUploadUnsupported', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: mediaStorage() }],
      ])

      const error = await runFailure(reconcileFile({ path }), fake)
      expect(error).toMatchObject({
        _tag: 'NmdNonBodyWriteBlockedError',
        page_id: pageId,
        guard: 'DurableFileUploadUnsupported',
        fileIds: ['hero-image'],
      })
      expect(fake.updateCount).toBe(0)
    }))

  it('surfaces the named guard on the dry-run plan (dry-run-visible, R15)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: mediaStorage() }],
      ])

      const error = await runFailure(reconcileFile({ path, dryRun: true }), fake)
      expect(error).toMatchObject({
        _tag: 'NmdNonBodyWriteBlockedError',
        guard: 'DurableFileUploadUnsupported',
      })
      // dry-run must not have mutated the remote even while raising the guard.
      expect(fake.updateCount).toBe(0)
    }))

  it('blocks a source: remote pull over byte-backed media with DurableFileWriteUnsupported', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: 'stale local' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Fresh remote', storage: mediaStorage() }],
      ])

      const error = await runFailure(reconcileFile({ path }), fake)
      expect(error).toMatchObject({
        _tag: 'NmdNonBodyWriteBlockedError',
        guard: 'DurableFileWriteUnsupported',
        fileIds: ['hero-image'],
      })
    }))

  it('proceeds over a page with no modeled file bytes (inert)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: emptyFilesStorage() }],
      ])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.updateCount).toBe(1)
      expect(fake.remoteMarkdown(pageId)).toContain('Local edit')
    }))

  it('blocks the shared reconcile path over byte-backed media with DurableFileWriteUnsupported (shared site)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: 'alpha\n\nbeta\n\ngamma', storage: mediaStorage() }],
      ])
      // Bootstrap as shared — sidecar captures mediaStorage() at track time.
      await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)

      // Create a real divergence: local and remote both changed from the base.
      await replaceNmdBody(path, 'alpha local\n\nbeta\n\ngamma')
      fake.mutateRemote(pageId, 'alpha\n\nbeta remote\n\ngamma')
      const beforeFile = await readFile(path, 'utf8')
      const sidecarPath = syncStatePath({ path, pageId })
      const beforeSidecar = await readFile(sidecarPath, 'utf8')
      const beforeRemote = fake.remoteMarkdown(pageId)

      const error = await runFailure(reconcileFile({ path }), fake)

      expect(error).toMatchObject({
        _tag: 'NmdNonBodyWriteBlockedError',
        page_id: pageId,
        guard: 'DurableFileWriteUnsupported',
        fileIds: ['hero-image'],
      })
      // Guard must short-circuit before any mutation.
      expect(fake.updateCount).toBe(0)
      expect(fake.remoteMarkdown(pageId)).toBe(beforeRemote)
      expect(await readFile(path, 'utf8')).toBe(beforeFile)
      expect(await readFile(sidecarPath, 'utf8')).toBe(beforeSidecar)
      expect(await exists(`${path}.conflict.roughdraft.md`)).toBe(false)
    }))
})

describe('reconcileFile — comment-write boundary (SM6.2)', () => {
  const commentStorage = (): NmdStorage => ({
    _tag: 'self_contained',
    unsupported_blocks: [],
    files: [],
    comments: [
      {
        _tag: 'comment_unit',
        id: 'comment-xyz',
        roughdraft_id: 'rd-002',
      },
    ],
  })

  const emptyCommentStorage = (): NmdStorage => ({
    _tag: 'self_contained',
    unsupported_blocks: [],
    files: [],
    comments: [],
  })

  it('proceeds on a source: local body-only push over a comment-bearing page', () =>
    withTempDir(async (dir) => {
      // A body-only `replace_content` push is structurally incapable of
      // mutating Notion comments, so the page merely having comments must not
      // block the push (mutation-implying, not presence-based).
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: commentStorage() }],
      ])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.updateCount).toBe(1)
    }))

  it('proceeds on a dry-run push over a comment-bearing page (no fictitious block)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: commentStorage() }],
      ])

      const result = await run(reconcileFile({ path, dryRun: true }), fake)
      expect(result).toMatchObject({ _tag: 'pushed', dryRun: true })
      expect(fake.updateCount).toBe(0)
    }))

  it('proceeds on a source: remote body-only pull over a comment-bearing page', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'remote', pageId, body: 'stale local' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Fresh remote', storage: commentStorage() }],
      ])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pulled')
    }))

  it('proceeds over a page with an empty comment inventory (inert)', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: emptyCommentStorage() }],
      ])

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('pushed')
      expect(fake.updateCount).toBe(1)
    }))

  it('statusFile over a comment-bearing page succeeds (reads stay supported)', () =>
    withTempDir(async (dir) => {
      // statusFile is read-only and never reaches the write gate, so a
      // non-empty comment inventory must not block a status check (R30).
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local edit\n\nnew text' })
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Old\n\nold text', storage: commentStorage() }],
      ])

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('local-ahead')
      expect(fake.updateCount).toBe(0)
    }))

  it('captures the comment inventory into the sidecar at shared track time', () =>
    withTempDir(async (dir) => {
      // trackPage{source:shared} writes the sidecar at track time. The comment
      // inventory in the gateway response must survive unchanged into the
      // sidecar so a later reconcile can read it back (storage layer, not the
      // write gate). This proves capture, not a full sync-cycle round-trip.
      const path = join(dir, 'doc.nmd')
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: '# Shared body', storage: commentStorage() }],
      ])

      await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)
      const sidecar = JSON.parse(await readFile(syncStatePath({ path, pageId }), 'utf8')) as {
        readonly storage: NmdStorage
      }

      expect(sidecar.storage).toMatchObject({
        _tag: 'self_contained',
        comments: [expect.objectContaining({ id: 'comment-xyz', roughdraft_id: 'rd-002' })],
      })
    }))

  it('proceeds on the shared merge path over a comment-bearing page (no fictitious block)', () =>
    withTempDir(async (dir) => {
      // A clean 3-way merge writes only the merged body and does not mutate the
      // comment inventory, so the shared write site must not block.
      const path = join(dir, 'doc.nmd')
      const fake = new FakeGateway([
        [pageId, { title: 'Doc', markdown: 'alpha\n\nbeta', storage: commentStorage() }],
      ])
      await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)

      // Local-only change from base; remote unchanged -> clean merge.
      await replaceNmdBody(path, 'alpha local\n\nbeta')

      const result = await run(reconcileFile({ path }), fake)
      expect(result._tag).toBe('shared-merged')
      expect(fake.updateCount).toBe(1)
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

  it('preserves pulled file/media storage when tracking as shared', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'tracked.nmd')
      const fake = new FakeGateway([
        [
          pageId,
          {
            title: 'Doc',
            markdown: '# Remote\n\n![Hero](attachments/hero.png)',
            storage: mediaStorage(),
          },
        ],
      ])

      const result = await run(trackPage({ pageId, outPath: path, source: 'shared' }), fake)
      const sidecar = JSON.parse(await readFile(syncStatePath({ path, pageId }), 'utf8')) as {
        readonly storage: NmdStorage
      }

      expect(result).toEqual({ path, pageId, source: 'shared' })
      expect(sidecar.storage).toMatchObject({
        _tag: 'self_contained',
        files: [expect.objectContaining({ id: 'hero-image', role: 'block_image' })],
      })
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

  it('plans explicit unknown-block deletion without mutating the remote page under dry-run', () =>
    withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeNmd({ path, source: 'local', pageId, body: '# Local replacement' })
      const fake = new FakeGateway([
        [
          pageId,
          {
            title: 'Doc',
            markdown: '# Remote\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
            storage: unsupportedStorage(),
            unknownBlockIds: [blockId],
          },
        ],
      ])

      const result = await run(
        reconcileFile({ path, allowDeletingUnknownBlocks: true, dryRun: true }),
        fake,
      )

      expect(result).toEqual({ _tag: 'pushed', path, pageId, dryRun: true })
      expect(fake.updateCount).toBe(0)
      expect(fake.remoteMarkdown(pageId)).toContain('<unknown')
    }))

  it('dry-run blocked destructive gates surface the named guard (UnknownBlockDeletion / ReviewMarkupAsContent)', () =>
    withTempDir(async (dir) => {
      // UnknownBlockDeletion: blocked without --allow-delete-unknown-blocks
      const unknownPath = join(dir, 'unknown.nmd')
      await writeNmd({ path: unknownPath, source: 'local', pageId, body: '# Local replacement' })
      const fakeUnknown = new FakeGateway([
        [
          pageId,
          {
            title: 'Doc',
            markdown: '# Remote\n\n<unknown url="https://www.notion.com/" alt="bookmark"/>',
            storage: unsupportedStorage(),
            unknownBlockIds: [blockId],
          },
        ],
      ])

      // Without allow flag: dry-run still blocks and surfaces named guard
      const unknownErr = await runFailure(
        reconcileFile({ path: unknownPath, dryRun: true }),
        fakeUnknown,
      )
      expect(unknownErr).toBeInstanceOf(NmdDestructiveBodyBlockedError)
      expect((unknownErr as NmdDestructiveBodyBlockedError).guard).toBe('UnknownBlockDeletion')
      expect((unknownErr as NmdDestructiveBodyBlockedError).allowFlag).toBe(
        '--allow-delete-unknown-blocks',
      )
      expect(fakeUnknown.updateCount).toBe(0)

      // ReviewMarkupAsContent: blocked without --allow-review-markup
      const markupPath = join(dir, 'markup.nmd')
      const markupPageId = '00000000-0000-4000-8000-000000000099'
      await writeNmd({
        path: markupPath,
        source: 'local',
        pageId: markupPageId,
        body: '# Local\n\n{==Body==}{>>Needs review.<<}{id="r1"}',
      })
      const fakeMarkup = new FakeGateway([
        [markupPageId, { title: 'Doc', markdown: '# Old\n\nBody' }],
      ])

      const markupErr = await runFailure(
        reconcileFile({ path: markupPath, dryRun: true }),
        fakeMarkup,
      )
      expect(markupErr).toBeInstanceOf(NmdDestructiveBodyBlockedError)
      expect((markupErr as NmdDestructiveBodyBlockedError).guard).toBe('ReviewMarkupAsContent')
      expect((markupErr as NmdDestructiveBodyBlockedError).allowFlag).toBe('--allow-review-markup')
      expect(fakeMarkup.updateCount).toBe(0)
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
      expect(fake.remoteMarkdown(pageId)).toBe(canonicalizeBlockMarkdown('2. a\n3. b'))

      const status = await run(statusFile({ path }), fake)
      expect(status.status).toBe('in-sync')
    }))
})
