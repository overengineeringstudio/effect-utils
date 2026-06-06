import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { NOTION_API_VERSION, type NmdPageState } from '@overeng/notion-effect-client'

import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import { composePushBody, parentRelPathFor, slugForRelPath, syncTree, type TreeOp } from './tree.ts'

const rootPageId = '00000000-0000-4000-8000-000000000001'

interface FakePageState {
  title: string
  markdown: string
  parentId: string | undefined
  inTrash: boolean
}

/** In-memory Notion subtree fake exercising create/move/archive/list verbs. */
class FakeTreeNotion {
  private readonly pages = new Map<string, FakePageState>()
  private counter = 1

  constructor() {
    this.pages.set(rootPageId, {
      title: 'Root',
      markdown: '# Root\n',
      parentId: undefined,
      inTrash: false,
    })
  }

  remoteBody(id: string): string {
    return this.require(id).markdown
  }

  /** Simulate a concurrent remote edit (someone edited the page on Notion). */
  mutateRemote(id: string, markdown: string): void {
    this.require(id).markdown = markdown
  }

  childTitles(id: string): readonly string[] {
    return [...this.pages.entries()]
      .filter(([, page]) => page.parentId === id && page.inTrash === false)
      .map(([, page]) => page.title)
  }

  isTrashed(id: string): boolean {
    return this.require(id).inTrash
  }

  liveCount(): number {
    return [...this.pages.values()].filter((page) => page.inTrash === false).length
  }

  addRemotePage(opts: {
    readonly parentId: string
    readonly title: string
    readonly markdown: string
  }): string {
    this.counter += 1
    const id = `00000000-0000-4000-8000-0000000${String(this.counter).padStart(5, '0')}`
    this.pages.set(id, {
      title: opts.title,
      markdown: opts.markdown,
      parentId: opts.parentId,
      inTrash: false,
    })
    return id
  }

  createCount = 0

  private require(id: string): FakePageState {
    const page = this.pages.get(id)
    if (page === undefined) throw new Error(`unknown page ${id}`)
    return page
  }

  private snapshot(id: string): RemotePageSnapshot {
    const page = this.require(id)
    return {
      id,
      title: page.title,
      title_property_key: 'title',
      url: `https://www.notion.so/${id.replaceAll('-', '')}`,
      parent:
        page.parentId === undefined
          ? { type: 'workspace', workspace: true }
          : { type: 'page_id', page_id: page.parentId },
      icon: null as NmdPageState['icon'],
      cover: null as NmdPageState['cover'],
      in_trash: page.inTrash,
      is_locked: false,
      last_edited_time: '2026-06-05T12:00:00.000Z',
      properties: {},
    }
  }

  private pull(id: string): PullPageResult {
    return {
      page: this.snapshot(id),
      markdown: { markdown: this.require(id).markdown, truncated: false, unknown_block_ids: [] },
    }
  }

  readonly layer = Layer.succeed(NotionMdGateway, {
    pullPage: ({ pageId }) => Effect.sync(() => this.pull(pageId)),
    updateMarkdown: ({ pageId, command }) =>
      Effect.sync(() => {
        const page = this.require(pageId)
        if (command._tag === 'replace_content') {
          page.markdown = command.markdown
        } else {
          // apply each search-and-replace, like Notion's update_content
          page.markdown = command.contentUpdates.reduce(
            (body, update) =>
              update.replaceAllMatches === true
                ? body.split(update.oldStr).join(update.newStr)
                : body.replace(update.oldStr, update.newStr),
            page.markdown,
          )
        }
        return {
          markdown: { markdown: page.markdown, truncated: false, unknown_block_ids: [] },
        }
      }),
    updatePageProperties: ({ pageId }) => Effect.sync(() => this.snapshot(pageId)),
    updatePageMetadata: ({ pageId }) => Effect.sync(() => this.snapshot(pageId)),
    listChildPages: ({ pageId }) =>
      Effect.sync(() =>
        [...this.pages.entries()]
          .filter(([, page]) => page.parentId === pageId && page.inTrash === false)
          .map(([id, page]) => ({ pageId: id, title: page.title })),
      ),
    createPage: ({ parentPageId, title, markdown }) =>
      Effect.sync(() => {
        this.counter += 1
        this.createCount += 1
        const id = `00000000-0000-4000-8000-0000000${String(this.counter).padStart(5, '0')}`
        this.pages.set(id, { title, markdown, parentId: parentPageId, inTrash: false })
        return this.snapshot(id)
      }),
    movePage: ({ pageId, parentPageId }) =>
      Effect.sync(() => {
        this.require(pageId).parentId = parentPageId
        return this.snapshot(pageId)
      }),
    archivePage: ({ pageId }) =>
      Effect.sync(() => {
        this.require(pageId).inTrash = true
        return this.snapshot(pageId)
      }),
  } satisfies NotionMdGatewayShape)
}

const NMD_HEADER = (title: string) =>
  [
    '---',
    JSON.stringify(
      {
        notion_md: {
          version: 2,
          api_version: NOTION_API_VERSION,
          object: 'page',
          page_id: null,
          url: null,
          parent: { _tag: 'page', id: rootPageId },
          page: { title, icon: null, cover: null, in_trash: false, is_locked: false },
          properties: {},
        },
      },
      null,
      2,
    ),
    '---',
    '',
  ].join('\n')

const unbound = (opts: { readonly title: string; readonly body: string }): string =>
  `${NMD_HEADER(opts.title)}\n${opts.body}\n`

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-tree-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = <A>(
  effect: Effect.Effect<A, unknown, NodeContext.NodeContext | NotionMdGateway | NmdStateStore>,
  fake: FakeTreeNotion,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)),
          NodeContext.layer,
        ),
      ),
    ),
  )

const opTags = (ops: readonly TreeOp[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const op of ops) counts[op._tag] = (counts[op._tag] ?? 0) + 1
  return counts
}

describe('notion-md tree helpers', () => {
  it('derives slugs and parent edges from the directory model (index.nmd root)', () => {
    const rootFile = 'index.nmd'
    expect(slugForRelPath({ relPath: 'index.nmd', rootFile })).toBe('index')
    expect(slugForRelPath({ relPath: 'alpha.nmd', rootFile })).toBe('alpha')
    expect(slugForRelPath({ relPath: 'sub/beta.nmd', rootFile })).toBe('sub/beta')
    expect(slugForRelPath({ relPath: 'sub/index.nmd', rootFile })).toBe('sub')

    expect(parentRelPathFor({ relPath: 'index.nmd', rootFile })).toBeUndefined()
    expect(parentRelPathFor({ relPath: 'alpha.nmd', rootFile })).toBe('index.nmd')
    expect(parentRelPathFor({ relPath: 'sub/index.nmd', rootFile })).toBe('index.nmd')
    expect(parentRelPathFor({ relPath: 'sub/beta.nmd', rootFile })).toBe('sub/index.nmd')
  })

  it('honors a README.nmd root-file convention', () => {
    const rootFile = 'README.nmd'
    expect(slugForRelPath({ relPath: 'README.nmd', rootFile })).toBe('README')
    expect(slugForRelPath({ relPath: 'alpha.nmd', rootFile })).toBe('alpha')
    expect(slugForRelPath({ relPath: 'sub/README.nmd', rootFile })).toBe('sub')

    expect(parentRelPathFor({ relPath: 'README.nmd', rootFile })).toBeUndefined()
    expect(parentRelPathFor({ relPath: 'alpha.nmd', rootFile })).toBe('README.nmd')
    expect(parentRelPathFor({ relPath: 'sub/README.nmd', rootFile })).toBe('README.nmd')
    expect(parentRelPathFor({ relPath: 'sub/beta.nmd', rootFile })).toBe('sub/README.nmd')
  })

  it('blank-line-separates derived child anchors (siblings survive replace_content)', () => {
    const body = composePushBody({
      resolvedBody: 'Parent body',
      children: [
        { title: 'A', pageId: '11111111-1111-4111-8111-111111111111' },
        { title: 'B', pageId: '22222222-2222-4222-8222-222222222222' },
      ],
    })
    // two anchors, each on its own line, separated by a blank line
    const anchors = body.split('\n').filter((line) => line.startsWith('<page'))
    expect(anchors).toHaveLength(2)
    expect(body).toContain('</page>\n\n<page')
  })
})

describe('notion-md tree reconcile lifecycle', () => {
  it('plan dry-run lists creates for a nested unbound tree without applying', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, 'guide'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(join(dir, 'guide', 'index.nmd'), unbound({ title: 'Guide', body: 'Guide.' }))
      await writeFile(join(dir, 'guide', 'setup.nmd'), unbound({ title: 'Setup', body: 'Setup.' }))

      const plan = await run(syncTree({ root: dir, rootPageId, plan: true }), fake)
      expect(plan.plan).toBe(true)
      // alpha + guide/index + guide/setup are creates (root is pre-bound); the
      // nested guide/setup must not fail on its pending-create parent.
      expect(opTags(plan.ops).create).toBe(3)
      // nothing applied: no live children created on the remote
      expect(fake.liveCount()).toBe(1)
    })
  })

  it('plan on an unchanged, already-synced tree reports all noop', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, 'guide'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(join(dir, 'guide', 'index.nmd'), unbound({ title: 'Guide', body: 'Guide.' }))
      await writeFile(join(dir, 'guide', 'setup.nmd'), unbound({ title: 'Setup', body: 'Setup.' }))

      // establish the tree (sidecars now exist at the tree-root anchor)
      await run(syncTree({ root: dir, rootPageId }), fake)

      // plan on the unchanged tree must read those sidecars and report noop —
      // the regression: classifyPlan read from the wrong dir and reported update.
      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(plan.plan).toBe(true)
      const counts = opTags(plan.ops)
      expect(counts.noop).toBe(4) // root + alpha + guide/index + guide/setup
      expect(counts.update).toBeUndefined()
      expect(counts.create).toBeUndefined()
    })
  })

  it('plan on a changed/extended tree reports update + create', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)

      // edit alpha's BODY while keeping its binding (an in-place edit), and add
      // an unbound child gamma. Using `unbound()` here would reset alpha's
      // page_id and make plan see it as a create instead of an update.
      const boundAlpha = await readFile(join(dir, 'alpha.nmd'), 'utf8')
      await writeFile(join(dir, 'alpha.nmd'), boundAlpha.replace('Alpha.', 'Alpha EDITED.'))
      await writeFile(join(dir, 'gamma.nmd'), unbound({ title: 'Gamma', body: 'Gamma.' }))

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      const counts = opTags(plan.ops)
      expect(counts.create).toBe(1) // gamma
      // alpha (edited) updates; the root updates because its derived child index
      // gains gamma's anchor. index.nmd (unchanged-but-reanchored) is an update.
      expect(counts.update).toBeGreaterThanOrEqual(1)
      expect(plan.ops.some((op) => op._tag === 'update' && op.relPath === 'alpha.nmd')).toBe(true)
      expect(plan.ops.some((op) => op._tag === 'create' && op.relPath === 'gamma.nmd')).toBe(true)
      // nothing applied: gamma not created on the remote (root + alpha only)
      expect(fake.liveCount()).toBe(2)
    })
  })

  it('plan reports a bound page move without mutating Notion', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(join(dir, 'sub', 'index.nmd'), unbound({ title: 'Sub', body: 'Sub.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaPath = join(dir, 'alpha.nmd')
      const alphaContent = await readFile(alphaPath, 'utf8')
      const alphaId = /"page_id": "([^"]+)"/u.exec(alphaContent)?.[1]
      expect(alphaId).toBeDefined()

      await rm(alphaPath)
      await writeFile(join(dir, 'sub', 'alpha.nmd'), alphaContent)

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(plan.ops.some((op) => op._tag === 'move' && op.relPath === 'sub/alpha.nmd')).toBe(
        true,
      )
      expect(fake.childTitles(rootPageId)).toContain('Alpha')
      expect(fake.childTitles(rootPageId)).toContain('Sub')
    })
  })

  it('creates a nested tree where a same-depth index anchors its siblings', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, 'guide'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      // guide/setup.nmd (same depth as guide/index.nmd) must not be created
      // before its anchor guide/index.nmd.
      await writeFile(join(dir, 'guide', 'setup.nmd'), unbound({ title: 'Setup', body: 'Setup.' }))
      await writeFile(join(dir, 'guide', 'index.nmd'), unbound({ title: 'Guide', body: 'Guide.' }))

      const result = await run(syncTree({ root: dir, rootPageId }), fake)
      expect(opTags(result.ops).create).toBe(2) // guide + setup
      // guide is a child of root; setup is a child of guide
      expect(fake.childTitles(rootPageId)).toEqual(['Guide'])
      const guideId = [...fake.childTitles(rootPageId)].length // sanity
      void guideId
      // setup lives under guide, not under root
      expect(fake.childTitles(rootPageId)).not.toContain('Setup')
    })
  })

  it('creates an unbound tree, binds ids back, derives the index, and is idempotent', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(
        join(dir, 'index.nmd'),
        unbound({ title: 'Root', body: 'Welcome. See [[alpha]] and [[beta]].' }),
      )
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      const first = await run(syncTree({ root: dir, rootPageId }), fake)
      const firstCounts = opTags(first.ops)
      expect(firstCounts.create).toBe(2) // alpha + beta (root is pre-bound)
      expect(fake.childTitles(rootPageId).toSorted()).toEqual(['Alpha', 'Beta'])

      // ids bound back into the files via the canonical renderer
      const alphaFile = await readFile(join(dir, 'alpha.nmd'), 'utf8')
      expect(alphaFile).toContain('"page_id": "00000000-0000-4000-8000-')
      // the root id supplied via --root is also bound back into index.nmd
      // (identity lives in the file for fresh-clone durability)
      const indexFile = await readFile(join(dir, 'index.nmd'), 'utf8')
      expect(indexFile).toContain(`"page_id": "${rootPageId}"`)

      // root body carries derived child anchors + resolved inline cross-ref links
      const rootBody = fake.remoteBody(rootPageId)
      expect(rootBody).toContain('<page url="https://app.notion.com/p/')
      expect(rootBody).toContain('[alpha](https://app.notion.com/p/')
      expect(rootBody).not.toContain('[[alpha]]')

      // re-sync is a pure noop (oracle is the last pushed body hash, no re-pull diff)
      const second = await run(syncTree({ root: dir }), fake)
      const secondCounts = opTags(second.ops)
      expect(secondCounts.create).toBeUndefined()
      expect(secondCounts.update).toBeUndefined()
      expect(secondCounts.noop).toBe(3)
    })
  })

  it('reconciles an edit, a move across parents (keeps id), and blocks trash by default', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(join(dir, 'sub', 'index.nmd'), unbound({ title: 'Sub', body: 'Sub.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      expect(fake.liveCount()).toBe(3) // root + alpha + sub

      // capture alpha's bound id, then move it under sub/
      const alphaPath = join(dir, 'alpha.nmd')
      const alphaContent = await readFile(alphaPath, 'utf8')
      const alphaId = /"page_id": "([^"]+)"/u.exec(alphaContent)?.[1]
      expect(alphaId).toBeDefined()
      await rm(alphaPath)
      await writeFile(
        join(dir, 'sub', 'alpha.nmd'),
        alphaContent.replace('Alpha.', 'Alpha edited.'),
      )

      const moved = await run(syncTree({ root: dir }), fake)
      const movedCounts = opTags(moved.ops)
      expect(movedCounts.move).toBe(1) // alpha rebinds under sub, not trash+recreate
      expect(fake.isTrashed(alphaId ?? '')).toBe(false)
      expect(fake.remoteBody(alphaId ?? '')).toContain('Alpha edited.')

      // delete sub/alpha.nmd: default sync reports blocked destructive intent,
      // preserves the index entry, and does not archive the remote page.
      await rm(join(dir, 'sub', 'alpha.nmd'))
      const blocked = await run(syncTree({ root: dir }), fake)
      expect(opTags(blocked.ops).trash_blocked).toBe(1)
      expect(opTags(blocked.ops).trash).toBeUndefined()
      expect(fake.isTrashed(alphaId ?? '')).toBe(false)

      const blockedAgain = await run(syncTree({ root: dir }), fake)
      expect(opTags(blockedAgain.ops).trash_blocked).toBe(1)
      expect(fake.isTrashed(alphaId ?? '')).toBe(false)

      const trashed = await run(
        syncTree({ root: dir, pushOptions: { path: dir, force: true } }),
        fake,
      )
      expect(opTags(trashed.ops).trash).toBe(1)
      expect(fake.isTrashed(alphaId ?? '')).toBe(true)
    })
  })

  it('fails closed on a dangling cross-ref BEFORE any remote mutation', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      // a child with a dangling ref: the run must abort before creating it.
      await writeFile(
        join(dir, 'alpha.nmd'),
        unbound({ title: 'Alpha', body: 'Dangling [[nope]] ref.' }),
      )
      const result = await Effect.runPromise(
        syncTree({ root: dir, rootPageId }).pipe(
          Effect.either,
          Effect.provide(
            Layer.mergeAll(
              fake.layer,
              NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)),
              NodeContext.layer,
            ),
          ),
        ),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(String(result.left)).toContain('Dangling cross-ref')
      }
      // nothing pushed: alpha was NOT created on the remote
      expect(fake.liveCount()).toBe(1)
    })
  })

  it('routes through the guarded engine: a concurrent remote edit conflicts, not clobbers', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root body.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Original alpha.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()

      // someone edits alpha on Notion AND we edit it locally → divergent edits
      fake.mutateRemote(alphaId ?? '', '# Alpha\n\nRemote-only concurrent edit.\n')
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Local-only edit.' }))
      // re-bind alpha's id into the rewritten file (simulates an in-place edit)
      const alphaContent = await readFile(join(dir, 'alpha.nmd'), 'utf8')
      await writeFile(
        join(dir, 'alpha.nmd'),
        alphaContent.replace('"page_id": null', `"page_id": "${alphaId}"`),
      )

      const result = await run(syncTree({ root: dir }), fake)
      // alpha is a CONFLICT, not a silent overwrite
      expect(result.ops.some((op) => op._tag === 'conflict' && op.relPath === 'alpha.nmd')).toBe(
        true,
      )
      // the remote body was NOT clobbered with the local edit
      expect(fake.remoteBody(alphaId ?? '')).toContain('Remote-only concurrent edit')
      expect(fake.remoteBody(alphaId ?? '')).not.toContain('Local-only edit')
      // a conflict artifact was written next to the file
      expect(await readFile(join(dir, 'alpha.nmd.conflict.roughdraft.md'), 'utf8')).toContain(
        'Body conflict',
      )
    })
  })

  it('is crash-idempotent: per-create id writeback prevents duplicate creation', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      expect(fake.createCount).toBe(2) // alpha + beta
      // root id was written back to index.nmd early (crash-recoverable entry point)
      expect(await readFile(join(dir, 'index.nmd'), 'utf8')).toContain(`"page_id": "${rootPageId}"`)

      // re-run (simulating a resume): no page is created again
      await run(syncTree({ root: dir }), fake)
      expect(fake.createCount).toBe(2)
      expect(fake.liveCount()).toBe(3) // root + alpha + beta, no duplicates
    })
  })

  it('accepts a legacy workspace manifest and infers the root file before planning', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, '.notion-md'), { recursive: true })
      await writeFile(join(dir, 'README.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(
        join(dir, '.notion-md', 'workspace.json'),
        `${JSON.stringify(
          {
            version: 1,
            root_page_id: rootPageId,
            pages: { [rootPageId]: 'README.nmd' },
          },
          null,
          2,
        )}\n`,
      )

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(plan.rootFile).toBe('README.nmd')
      expect(plan.rootPageId).toBe(rootPageId)
    })
  })

  it('materializes duplicate remote title slugs to unique forward-sync paths', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const leafId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Same',
        markdown: 'Leaf body.\n',
      })
      const subtreeId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Same',
        markdown: 'Subtree body.\n',
      })
      fake.addRemotePage({ parentId: subtreeId, title: 'Child', markdown: 'Child body.\n' })

      const result = await run(
        syncTree({ root: dir, rootPageId, fromRemote: true, rootFile: 'index.nmd' }),
        fake,
      )
      expect(opTags(result.ops).materialize).toBe(4)
      expect(await readFile(join(dir, 'same.nmd'), 'utf8')).toContain(`"page_id": "${leafId}"`)
      expect(
        await readFile(
          join(dir, `same-${subtreeId.replaceAll('-', '').slice(-6)}`, 'index.nmd'),
          'utf8',
        ),
      ).toContain(`"page_id": "${subtreeId}"`)

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(plan.ops.some((op) => op._tag === 'update')).toBe(false)
    })
  })

  it('strips derived child anchors from from-remote file bodies while keeping composed baselines', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const childId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Alpha body.\n',
      })
      fake.mutateRemote(
        rootPageId,
        `Root body.\n\n<page url="https://app.notion.com/p/${childId.replaceAll('-', '')}">Alpha</page>\n`,
      )

      await run(syncTree({ root: dir, rootPageId, fromRemote: true, rootFile: 'index.nmd' }), fake)
      const rootFile = await readFile(join(dir, 'index.nmd'), 'utf8')
      expect(rootFile).toContain('Root body.')
      expect(rootFile).not.toContain('<page url=')

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(opTags(plan.ops).noop).toBe(2)
      expect(opTags(plan.ops).update).toBeUndefined()
    })
  })
})
