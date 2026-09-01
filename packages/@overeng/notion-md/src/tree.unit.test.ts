import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import type { NodeServices as NodeServicesEnv } from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { classifyBodyCompleteness, type BodyCompleteness } from '@overeng/notion-core'
import { NOTION_API_VERSION, type NmdPageState } from '@overeng/notion-effect-client'

import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemotePageSnapshot,
} from './model.ts'
import { statusPath, syncPath, trackPath } from './path.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import { statusPage } from './sync.ts'
import {
  composePushBody,
  pageUrl,
  parentRelPathFor,
  slugForRelPath,
  syncTree,
  type TreeOp,
} from './tree.ts'

const rootPageId = '00000000-0000-4000-8000-000000000001'

interface FakePageState {
  title: string
  markdown: string
  completeness: BodyCompleteness
  parentId: string | undefined
  inTrash: boolean
}

/** In-memory Notion subtree fake exercising create/move/archive/list verbs. */
class FakeTreeNotion {
  private readonly pages = new Map<string, FakePageState>()
  private readonly lossyAfterNextUpdate = new Map<string, BodyCompleteness>()
  private counter = 1

  constructor() {
    this.pages.set(rootPageId, {
      title: 'Root',
      markdown: '# Root\n',
      completeness: { _tag: 'complete' },
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

  renameRemote(id: string, title: string): void {
    this.require(id).title = title
  }

  trashRemote(id: string): void {
    this.require(id).inTrash = true
  }

  /** Simulate a write that succeeds but whose refreshed Markdown observation is lossy. */
  markRemoteBodyLossyAfterNextUpdate(id: string, completeness: BodyCompleteness): void {
    this.lossyAfterNextUpdate.set(id, completeness)
  }

  /** Set a page's current remote completeness verdict (test-only). */
  setRemoteCompleteness(id: string, completeness: BodyCompleteness): void {
    this.require(id).completeness = completeness
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
      completeness: { _tag: 'complete' },
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
      markdown: {
        markdown: this.require(id).markdown,
        truncated: false,
        unknown_block_ids: [],
        completeness: this.require(id).completeness,
      },
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
        const lossyAfterUpdate = this.lossyAfterNextUpdate.get(pageId)
        if (lossyAfterUpdate !== undefined) {
          page.completeness = lossyAfterUpdate
          this.lossyAfterNextUpdate.delete(pageId)
        }
        return {
          markdown: { markdown: page.markdown, truncated: false, unknown_block_ids: [] },
        }
      }),
    updatePageProperties: ({ pageId }) => Effect.sync(() => this.snapshot(pageId)),
    updatePageMetadata: ({ pageId }) => Effect.sync(() => this.snapshot(pageId)),
    retrieveDataSource: ({ dataSourceId }) =>
      Effect.succeed({ id: dataSourceId, databaseId: dataSourceId, properties: {} }),
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
        this.pages.set(id, {
          title,
          markdown,
          completeness: { _tag: 'complete' },
          parentId: parentPageId,
          inTrash: false,
        })
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
          source: 'local',
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

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServicesEnv | NotionMdGateway | NmdStateStore>,
  fake: FakeTreeNotion,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
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
      expect(plan.ops.some((op) => op._tag === 'move' && op.relPath === 'sub/alpha.nmd')).toBe(true)
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
      const creates = first.ops.filter((op) => op._tag === 'create')
      expect(creates).toHaveLength(2)
      expect(creates.every((op) => op.pageId !== undefined)).toBe(true)
      expect(creates.every((op) => op.url?.startsWith('https://www.notion.so/') === true)).toBe(
        true,
      )
      expect(fake.childTitles(rootPageId).toSorted()).toEqual(['Alpha', 'Beta'])

      // ids bound back into the files via the canonical renderer
      const alphaFile = await readFile(join(dir, 'alpha.nmd'), 'utf8')
      expect(alphaFile).toContain('"page_id": "00000000-0000-4000-8000-')
      // the root id supplied via --root is also bound back into index.nmd
      // (identity lives in the file for fresh-checkout durability)
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

  it('validates and preserves a curated child index with interleaved annotations', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      const betaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'beta.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()
      expect(betaId).toBeDefined()

      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')
      const curatedBody = [
        'Root intro.',
        '',
        '## Page index',
        '',
        `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
        'Alpha annotation stays with the anchor.',
        '',
        `<page url="${pageUrl(betaId ?? '')}">Beta</page>`,
        'Beta annotation stays with the anchor.',
        '',
        '## Notes',
        '',
        'A section after the index must not receive appended anchors.',
      ].join('\n')
      await writeFile(join(dir, 'index.nmd'), boundIndex.replace('Root intro.', curatedBody))

      const result = await run(syncTree({ root: dir }), fake)
      expect(result.ops.some((op) => op._tag === 'update' && op.relPath === 'index.nmd')).toBe(true)
      expect(fake.remoteBody(rootPageId)).toBe(`${curatedBody}\n`)
      expect(fake.remoteBody(rootPageId)).toContain('Alpha annotation stays with the anchor.')
      expect(fake.remoteBody(rootPageId)).not.toMatch(/Notes[\s\S]*<page/u)

      const second = await run(syncTree({ root: dir }), fake)
      expect(opTags(second.ops).noop).toBe(3)
    })
  })

  it('fills URL-less authored child anchors after creating new children', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()

      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')
      const curatedBody = [
        'Root intro.',
        '',
        '## Page index',
        '',
        `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
        'Alpha annotation.',
        '',
        '<page>Beta</page>',
        'Beta annotation.',
        '',
        '## Notes',
        '',
        'Nothing should be appended below this section.',
      ].join('\n')
      await writeFile(join(dir, 'index.nmd'), boundIndex.replace('Root intro.', curatedBody))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      const result = await run(syncTree({ root: dir }), fake)
      expect(opTags(result.ops).create).toBe(1)
      const betaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'beta.nmd'), 'utf8'),
      )?.[1]
      expect(betaId).toBeDefined()
      expect(fake.remoteBody(rootPageId)).toContain(
        `<page url="${pageUrl(betaId ?? '')}">Beta</page>`,
      )
      expect(fake.remoteBody(rootPageId)).toContain('Beta annotation.')
      expect(fake.remoteBody(rootPageId)).not.toMatch(/Notes[\s\S]*<page/u)

      const second = await run(syncTree({ root: dir }), fake)
      expect(opTags(second.ops).noop).toBe(3)
    })
  })

  it('plans URL-less authored child anchors for pending children without applying', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()

      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')
      await writeFile(
        join(dir, 'index.nmd'),
        boundIndex.replace(
          'Root intro.',
          [
            'Root intro.',
            '',
            `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
            '',
            '<page>Beta</page>',
          ].join('\n'),
        ),
      )
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      const plan = await run(syncTree({ root: dir, plan: true }), fake)
      expect(plan.ops.some((op) => op._tag === 'create' && op.relPath === 'beta.nmd')).toBe(true)
      expect(plan.ops.some((op) => op._tag === 'update' && op.relPath === 'index.nmd')).toBe(true)
      expect(fake.childTitles(rootPageId)).toEqual(['Alpha'])
    })
  })

  it('blank-line-separates adjacent authored child anchors before pushing', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      const betaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'beta.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()
      expect(betaId).toBeDefined()

      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')
      await writeFile(
        join(dir, 'index.nmd'),
        boundIndex.replace(
          'Root intro.',
          [
            'Root intro.',
            '',
            `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
            `<page url="${pageUrl(betaId ?? '')}">Beta</page>`,
            '',
            'After the index.',
          ].join('\n'),
        ),
      )

      await run(syncTree({ root: dir }), fake)
      expect(fake.remoteBody(rootPageId)).toContain(
        `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>\n\n<page url="${pageUrl(betaId ?? '')}">Beta</page>`,
      )
    })
  })

  it('rejects an authored child index when a local child anchor is missing', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))
      await writeFile(join(dir, 'beta.nmd'), unbound({ title: 'Beta', body: 'Beta body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()
      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')
      await writeFile(
        join(dir, 'index.nmd'),
        boundIndex.replace(
          'Root intro.',
          ['Root intro.', '', `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`].join('\n'),
        ),
      )
      const before = fake.remoteBody(rootPageId)
      await expect(run(syncTree({ root: dir }), fake)).rejects.toThrow('Missing child anchor')
      expect(fake.remoteBody(rootPageId)).toBe(before)
    })
  })

  it('rejects an authored child index when an anchor is duplicated or dangling', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root intro.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaId = /"page_id": "([^"]+)"/u.exec(
        await readFile(join(dir, 'alpha.nmd'), 'utf8'),
      )?.[1]
      expect(alphaId).toBeDefined()
      const boundIndex = await readFile(join(dir, 'index.nmd'), 'utf8')

      await writeFile(
        join(dir, 'index.nmd'),
        boundIndex.replace(
          'Root intro.',
          [
            'Root intro.',
            '',
            `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
            '',
            `<page url="${pageUrl(alphaId ?? '')}">Alpha again</page>`,
          ].join('\n'),
        ),
      )
      await expect(run(syncTree({ root: dir }), fake)).rejects.toThrow('Duplicate child anchor')

      await writeFile(
        join(dir, 'index.nmd'),
        boundIndex.replace(
          'Root intro.',
          [
            'Root intro.',
            '',
            `<page url="${pageUrl(alphaId ?? '')}">Alpha</page>`,
            '',
            '<page url="https://app.notion.com/p/99999999999949998999999999999999">Ghost</page>',
          ].join('\n'),
        ),
      )
      await expect(run(syncTree({ root: dir }), fake)).rejects.toThrow('Dangling child anchor')
    })
  })

  it('rejects single-file page/path operations for managed tree members', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaPath = join(dir, 'alpha.nmd')

      await expect(run(statusPage({ path: alphaPath }), fake)).rejects.toThrow(
        'is a member of the notion-md tree',
      )
      await expect(run(statusPath({ path: alphaPath }), fake)).rejects.toThrow(
        'is a member of the notion-md tree',
      )
      await expect(run(syncPath({ path: alphaPath }), fake)).rejects.toThrow(
        'is a member of the notion-md tree',
      )
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
          Effect.result,
          Effect.provide(
            Layer.mergeAll(
              fake.layer,
              NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer)),
              NodeServices.layer,
            ),
          ),
        ),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(String(result.failure)).toContain('Dangling cross-ref')
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

  it('refuses to settle a tree body write when the post-write remote body is lossy', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root body.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Original alpha.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      const alphaPath = join(dir, 'alpha.nmd')
      const alphaId = /"page_id": "([^"]+)"/u.exec(await readFile(alphaPath, 'utf8'))?.[1]
      expect(alphaId).toBeDefined()

      const alphaContent = await readFile(alphaPath, 'utf8')
      await writeFile(alphaPath, alphaContent.replace('Original alpha.', 'Local alpha.\n\n---'))
      fake.markRemoteBodyLossyAfterNextUpdate(alphaId ?? '', {
        _tag: 'lossy',
        reasons: ['rendered_markdown_has_unobserved_suffix'],
      })

      await expect(run(syncTree({ root: dir }), fake)).rejects.toThrow('Remote Markdown body')
      expect(await readFile(alphaPath, 'utf8')).toContain('Local alpha')
    })
  })

  // R38/#785 + R12/R30: a tree PARENT legitimately contains child_page blocks
  // for its sub-pages. The classifier flags child_page as not-round-trip-safe,
  // but the tree gate must TOLERATE the node's own child pages (managed as
  // <page> anchors) — otherwise every multi-page tree would be refused.
  const childPageVerdict = (extraTypes: readonly string[] = []) =>
    classifyBodyCompleteness({
      markdown: { markdown: 'Root body.', truncated: false, unknownBlockIds: [] },
      inventory: {
        entries: [
          { id: 'b-1', type: 'paragraph', hasChildren: false, inTrash: false },
          { id: 'b-2', type: 'child_page', hasChildren: true, inTrash: false },
          ...extraTypes.map((type, i) => ({
            id: `b-x${i}`,
            type,
            hasChildren: false,
            inTrash: false,
          })),
        ],
        renderedMarkdown: 'Root body.',
      },
    })

  it('tolerates a tree node whose only lossy block is its own child_page (R12/R30)', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root body.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      // First sync binds ids and establishes baselines.
      await run(syncTree({ root: dir, rootPageId }), fake)
      // Now the root's remote body classifies lossy *only* because it contains a
      // child_page block (its sub-page). The tree gate must not refuse it.
      const verdict = childPageVerdict()
      expect(verdict).toEqual({
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: ['child_page'],
      })
      fake.setRemoteCompleteness(rootPageId, verdict)

      // A subsequent sync must still succeed (no refusal).
      const result = await run(syncTree({ root: dir }), fake)
      expect(result.ops.length).toBeGreaterThan(0)
    })
  })

  it('still refuses a tree node that ALSO has a real lossy block (#785 stays fixed on the tree path)', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root body.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha body.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)
      // Root now has child_page (tolerated) AND a table_of_contents (must refuse).
      fake.setRemoteCompleteness(rootPageId, childPageVerdict(['table_of_contents']))
      // Force a local change so the gate is reached on push.
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Edited root body.' }))

      await expect(run(syncTree({ root: dir }), fake)).rejects.toThrow('table_of_contents')
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

      fake.mutateRemote(
        rootPageId,
        [
          `Root body.`,
          '',
          `<page url="${pageUrl(leafId)}">Same</page>`,
          '',
          `<page url="${pageUrl(subtreeId)}">Same</page>`,
          '',
        ].join('\n'),
      )

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

      const plan = await run(syncTree({ root: dir, plan: true, fromRemote: false }), fake)
      expect(plan.ops.some((op) => op._tag === 'update')).toBe(false)
      const rootFile = await readFile(join(dir, 'index.nmd'), 'utf8')
      expect(rootFile).toContain('[Same](same.nmd)')
      expect(rootFile).toContain(
        `[Same](same-${subtreeId.replaceAll('-', '').slice(-6)}/index.nmd)`,
      )
    })
  })

  it('refuses an ambiguous title-only child placeholder', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      fake.addRemotePage({ parentId: rootPageId, title: 'Same', markdown: 'First.\n' })
      fake.addRemotePage({ parentId: rootPageId, title: 'Same', markdown: 'Second.\n' })
      fake.mutateRemote(rootPageId, 'Root body.\n\n[Same]()\n')

      await expect(
        run(syncTree({ root: dir, rootPageId, fromRemote: true }), fake),
      ).rejects.toThrow(
        'Ambiguous child placeholder "Same" in index.nmd; use an id-bearing child anchor',
      )
    })
  })

  it('preserves user-authored links to child files in local-authoritative trees', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await writeFile(
        join(dir, 'index.nmd'),
        unbound({ title: 'Root', body: 'Root.\n\n[Read the details](alpha.nmd)' }),
      )
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))

      await run(syncTree({ root: dir, rootPageId }), fake)

      expect(fake.remoteBody(rootPageId)).toContain('[Read the details](https://app.notion.com/p/')
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

      const plan = await run(syncTree({ root: dir, plan: true, fromRemote: false }), fake)
      expect(opTags(plan.ops).noop).toBe(2)
      expect(rootFile).toContain('[Alpha](alpha.nmd)')
      expect(opTags(plan.ops).update).toBeUndefined()
    })
  })
})

describe('track path routing', () => {
  it('materializes an existing directory as a remote subtree with a workspace manifest', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const guideId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Guide',
        markdown: 'Guide body.\n\n[Setup]()\n',
      })
      const setupId = fake.addRemotePage({
        parentId: guideId,
        title: 'Setup',
        markdown: 'Setup body.\n',
      })
      fake.mutateRemote(rootPageId, 'Root body.\n\n[Guide]()\n')

      const result = await run(
        trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }),
        fake,
      )

      expect(result).toMatchObject({
        _tag: 'tree',
        root: dir,
        rootPageId,
        rootFile: 'index.nmd',
        direction: 'from-remote',
        plan: false,
      })
      expect(await readFile(join(dir, 'index.nmd'), 'utf8')).toContain(`"page_id": "${rootPageId}"`)
      expect(await readFile(join(dir, 'guide', 'index.nmd'), 'utf8')).toContain(
        `"page_id": "${guideId}"`,
      )
      expect(await readFile(join(dir, 'guide', 'setup.nmd'), 'utf8')).toContain(
        `"page_id": "${setupId}"`,
      )
      expect(await readFile(join(dir, 'guide', 'setup.nmd'), 'utf8')).toContain(
        '"source": "remote"',
      )
      const rootContent = await readFile(join(dir, 'index.nmd'), 'utf8')
      expect(rootContent).toContain('[Guide](guide/index.nmd)')
      expect(rootContent).not.toContain('[Guide]()')
      const guideContent = await readFile(join(dir, 'guide', 'index.nmd'), 'utf8')
      expect(guideContent).toContain('[Setup](setup.nmd)')
      expect(guideContent).not.toContain('[Setup]()')
      const forwardPlan = await run(syncTree({ root: dir, fromRemote: false, plan: true }), fake)
      expect(opTags(forwardPlan.ops).noop).toBe(3)
      expect(opTags(forwardPlan.ops).update).toBeUndefined()
      expect(JSON.parse(await readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8'))).toEqual(
        {
          version: 1,
          root_page_id: rootPageId,
          root_file: 'index.nmd',
          authority: 'remote',
          pages: {
            'guide/index.nmd': guideId,
            'guide/setup.nmd': setupId,
          },
        },
      )
    })
  })

  it('keeps a missing .nmd target on the single-page track path', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const outPath = join(dir, 'root.nmd')

      const result = await run(trackPath({ pageId: rootPageId, outPath, source: 'remote' }), fake)

      expect(result).toEqual({ path: outPath, pageId: rootPageId, source: 'remote' })
      expect(await readFile(outPath, 'utf8')).toContain('"source": "remote"')
      await expect(
        readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('rejects a non-remote source for a directory instead of silently ignoring it', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()

      await expect(
        run(trackPath({ pageId: rootPageId, outPath: dir, source: 'shared' }), fake),
      ).rejects.toThrow(
        'Directory track targets only support --as remote; use a .nmd file target with --as shared',
      )
    })
  })

  it('refreshes remote content on ordinary directory sync', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const alphaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Original body.\n',
      })
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)

      fake.mutateRemote(alphaId, 'Refreshed body.\n')
      const result = await run(syncPath({ path: dir }), fake)

      expect(result).toMatchObject({ _tag: 'tree', direction: 'from-remote' })
      expect(await readFile(join(dir, 'alpha.nmd'), 'utf8')).toContain('Refreshed body.')
    })
  })

  it('moves a tracked page by page id when its remote title and path change', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const alphaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Alpha body.\n',
      })
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)

      fake.renameRemote(alphaId, 'Handbook')
      const result = await run(syncPath({ path: dir }), fake)

      expect(result._tag === 'tree' ? result.ops : []).toContainEqual({
        _tag: 'move',
        relPath: 'handbook.nmd',
        pageId: alphaId,
      })
      await expect(readFile(join(dir, 'alpha.nmd'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readFile(join(dir, 'handbook.nmd'), 'utf8')).toContain(`"page_id": "${alphaId}"`)
    })
  })

  it('adds and deletes recorded remote pages without deleting unknown local files', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const alphaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Alpha body.\n',
      })
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)
      await writeFile(join(dir, 'local-notes.nmd'), 'unknown local file\n')

      fake.trashRemote(alphaId)
      const betaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Beta',
        markdown: 'Beta body.\n',
      })
      const result = await run(syncPath({ path: dir }), fake)

      expect(result._tag === 'tree' ? result.ops : []).toEqual(
        expect.arrayContaining([
          { _tag: 'delete', relPath: 'alpha.nmd', pageId: alphaId },
          { _tag: 'materialize', relPath: 'beta.nmd', pageId: betaId },
        ]),
      )
      await expect(readFile(join(dir, 'alpha.nmd'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readFile(join(dir, 'beta.nmd'), 'utf8')).toContain('Beta body.')
      expect(await readFile(join(dir, 'local-notes.nmd'), 'utf8')).toBe('unknown local file\n')
    })
  })

  it('refuses a remote addition that would overwrite an unknown local file', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)
      const unknownPath = join(dir, 'local-notes.nmd')
      await writeFile(unknownPath, 'unknown local file\n')
      fake.addRemotePage({
        parentId: rootPageId,
        title: 'Local Notes',
        markdown: 'Remote body.\n',
      })

      await expect(run(syncPath({ path: dir }), fake)).rejects.toThrow(
        `Refusing to overwrite untracked local file ${unknownPath}`,
      )
      expect(await readFile(unknownPath, 'utf8')).toBe('unknown local file\n')
    })
  })

  it('refuses to overwrite a tracked path rebound to another page', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const alphaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Alpha body.\n',
      })
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)
      const alphaPath = join(dir, 'alpha.nmd')
      const reboundId = '99999999-9999-4999-8999-999999999999'
      const reboundFile = (await readFile(alphaPath, 'utf8')).replaceAll(alphaId, reboundId)
      await writeFile(alphaPath, reboundFile)

      await expect(run(syncPath({ path: dir }), fake)).rejects.toThrow(
        `Refusing to overwrite tracked local file ${alphaPath}: expected page ${alphaId}, found ${reboundId}`,
      )
      expect(await readFile(alphaPath, 'utf8')).toBe(reboundFile)
    })
  })

  it('allows remote page moves between paths occupied by their tracked predecessors', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      const alphaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Alpha',
        markdown: 'Alpha body.\n',
      })
      const betaId = fake.addRemotePage({
        parentId: rootPageId,
        title: 'Beta',
        markdown: 'Beta body.\n',
      })
      await run(trackPath({ pageId: rootPageId, outPath: dir, source: 'remote' }), fake)

      fake.renameRemote(alphaId, 'Beta')
      fake.renameRemote(betaId, 'Alpha')
      const result = await run(syncPath({ path: dir }), fake)

      expect(result._tag === 'tree' ? result.ops : []).toEqual(
        expect.arrayContaining([
          { _tag: 'move', relPath: 'beta.nmd', pageId: alphaId },
          { _tag: 'move', relPath: 'alpha.nmd', pageId: betaId },
        ]),
      )
      expect(await readFile(join(dir, 'alpha.nmd'), 'utf8')).toContain(`"page_id": "${betaId}"`)
      expect(await readFile(join(dir, 'beta.nmd'), 'utf8')).toContain(`"page_id": "${alphaId}"`)
    })
  })

  it('defaults a legacy workspace manifest without authority to local tree sync', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeTreeNotion()
      await mkdir(join(dir, '.notion-md'), { recursive: true })
      await writeFile(join(dir, 'index.nmd'), unbound({ title: 'Root', body: 'Root.' }))
      await writeFile(join(dir, 'alpha.nmd'), unbound({ title: 'Alpha', body: 'Alpha.' }))
      await writeFile(
        join(dir, '.notion-md', 'workspace.json'),
        `${JSON.stringify({
          version: 1,
          root_page_id: rootPageId,
          root_file: 'index.nmd',
          pages: {},
        })}\n`,
      )

      const result = await run(syncPath({ path: dir }), fake)

      expect(result).toMatchObject({ _tag: 'tree', direction: 'local' })
      expect(fake.childTitles(rootPageId)).toEqual(['Alpha'])
      expect(
        JSON.parse(await readFile(join(dir, '.notion-md', 'workspace.json'), 'utf8')),
      ).toMatchObject({ authority: 'local' })
    })
  })
})
