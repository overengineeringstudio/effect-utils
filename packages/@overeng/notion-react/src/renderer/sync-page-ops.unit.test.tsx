import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { CACHE_SCHEMA_VERSION, type CacheTree } from '../cache/types.ts'
import { ChildPage, Page, Paragraph, Toggle } from '../components/blocks.ts'
import { createFakeNotion, FakeNotionResponseError, type FakeNotion } from '../test/mock-client.ts'
import { normalizeCover, projectCover } from './icons.ts'
import { sync } from './sync.ts'

/**
 * Driver-level coverage for the page-scope op plumbing introduced in #618
 * phase 3b. Scenarios mirror the phase-3b prompt acceptance list: create,
 * update-coalesce, archive, move, nodeKind-LCS boundary, partial-failure
 * rollback.
 */
const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const runSync = async (
  fake: FakeNotion,
  element: Parameters<typeof sync>[0],
  cache = InMemoryCache.make(),
) => {
  return await runWith(
    fake,
    sync(element, { pageId: ROOT, cache }).pipe(
      Effect.mapError((cause) => new Error(String(cause))),
    ),
  )
}

describe('sync() page ops (issue #618 phase 3b)', () => {
  it('create: <Page><ChildPage/></Page> first-sync → 1 createPage, 0 block ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const res = await runSync(
      fake,
      <Page>
        <ChildPage title="child" />
      </Page>,
      cache,
    )
    expect(res.pages).toMatchObject({ creates: 1, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: res.appends,
      inserts: res.inserts,
      updates: res.updates,
      removes: res.removes,
    }).toEqual({
      appends: 0,
      inserts: 0,
      updates: 0,
      removes: 0,
    })
    // Server state: one page posted, one child_page block auto-materialized.
    expect(fake.pages.size).toBe(1)
    const [created] = [...fake.pages.values()]
    expect(created!.properties.title.title[0]?.text.content).toBe('child')
  })

  it('idempotent: rendering the same <Page><ChildPage/></Page> twice → 0 ops on second sync', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <ChildPage title="child" />
      </Page>
    )
    await runSync(fake, tree, cache)
    const before = fake.requests.length
    const second = await runSync(fake, tree, cache)
    expect(second.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: second.appends,
      inserts: second.inserts,
      updates: second.updates,
      removes: second.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
    // Only the pre-flight drift GET should hit the wire on a clean resync.
    const after = fake.requests.slice(before)
    expect(after.filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('root-page metadata: <Page title> change → 1 updatePage on root, 0 block ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page title="v1">
        <Paragraph>body</Paragraph>
      </Page>,
      cache,
    )
    const before = fake.requests.length
    const res = await runSync(
      fake,
      <Page title="v2">
        <Paragraph>body</Paragraph>
      </Page>,
      cache,
    )
    expect(res.pages).toMatchObject({ creates: 0, updates: 1, archives: 0, moves: 0 })
    expect(res.updates + res.appends + res.inserts + res.removes).toBe(0)
    const after = fake.requests.slice(before)
    const pagePatches = after.filter(
      (r) => r.method === 'PATCH' && /^\/v1\/pages\/[^/]+$/.test(r.path),
    )
    expect(pagePatches).toHaveLength(1)
  })

  it('sub-page metadata: <ChildPage icon> change → 1 updatePage on the sub-page, 0 others', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage title="doc" icon={{ type: 'emoji', emoji: '📄' }} />
      </Page>,
      cache,
    )
    const before = fake.requests.length
    const res = await runSync(
      fake,
      <Page>
        <ChildPage title="doc" icon={{ type: 'emoji', emoji: '🧪' }} />
      </Page>,
      cache,
    )
    expect(res.pages).toMatchObject({ creates: 0, updates: 1, archives: 0, moves: 0 })
    const after = fake.requests.slice(before)
    const patches = after.filter((r) => r.method === 'PATCH' && /^\/v1\/pages\/[^/]+$/.test(r.path))
    expect(patches).toHaveLength(1)
    const body = patches[0]!.body as { icon?: { emoji?: string }; properties?: unknown }
    expect(body.icon).toEqual({ type: 'emoji', emoji: '🧪' })
    expect(body.properties).toBeUndefined()
  })

  it('remove: <Page><ChildPage/></Page> → <Page/> emits 1 archivePage, 0 block ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage title="doc" />
      </Page>,
      cache,
    )
    const before = fake.requests.length
    const res = await runSync(fake, <Page />, cache)
    expect(res.pages).toMatchObject({ creates: 0, updates: 0, archives: 1, moves: 0 })
    expect(res.removes + res.appends + res.inserts + res.updates).toBe(0)
    const after = fake.requests.slice(before)
    const patches = after.filter((r) => r.method === 'PATCH' && /^\/v1\/pages\/[^/]+$/.test(r.path))
    expect(patches).toHaveLength(1)
    // One of the fake pages must now be in_trash.
    const trashed = [...fake.pages.values()].filter((p) => p.in_trash)
    expect(trashed).toHaveLength(1)
  })

  it('move: sibling reshuffle of sub-pages → 1 movePage, 0 create/archive', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage blockKey="a" title="Alpha" />
        <ChildPage blockKey="b" title="Beta" />
      </Page>,
      cache,
    )
    const before = fake.requests.length
    // Re-order siblings. LCS retains one; the other becomes a move (identity
    // preserved via blockKey, no archive+create). Notion has no sibling-
    // reorder API so the unretained sibling materializes as a `pages.move`
    // with the same parent — semantically a no-op reparent, but this is the
    // contract in phase 3b: reordered pages flow through movePage.
    const res = await runSync(
      fake,
      <Page>
        <ChildPage blockKey="b" title="Beta" />
        <ChildPage blockKey="a" title="Alpha" />
      </Page>,
      cache,
    )
    expect(res.pages).toMatchObject({ creates: 0, archives: 0, moves: 1 })
    expect(res.appends + res.inserts + res.removes + res.updates).toBe(0)
    // Exactly one POST .../move on the wire (plus the pre-flight drift GET).
    const after = fake.requests.slice(before)
    const moves = after.filter((r) => r.method === 'POST' && r.path.endsWith('/move'))
    expect(moves).toHaveLength(1)
  })

  it('nodeKind LCS boundary: same key+type but block vs page → remove+create, not update', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // First sync: paragraph with blockKey=k.
    await runSync(
      fake,
      <>
        <Paragraph blockKey="k">hello</Paragraph>
      </>,
      cache,
    )
    // Second sync: a ChildPage with the same blockKey. Same key, different
    // nodeKind → must NOT be an update. Expected: 1 remove (block) + 1
    // createPage.
    const res = await runSync(fake, <ChildPage blockKey="k" title="doc" />, cache)
    expect(res.removes).toBe(1)
    expect(res.pages).toMatchObject({ creates: 1, updates: 0 })
  })

  it('partial-failure: createPage succeeds but scope-tail block ops fail → new page archived, fallbackReason set', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Pack >100 direct children so `inlinePackChildren` tails the overflow.
    // Then fail any children-append — the only such calls after createPage
    // will be for the tail. Sync must archive the newly-created page.
    const manyParagraphs = Array.from({ length: 105 }, (_, i) => (
      <Paragraph key={String(i)} blockKey={`p${i}`}>{`p${i}`}</Paragraph>
    ))
    // Trigger failure on any PATCH /v1/blocks/{id}/children — that's the
    // append endpoint the tail ops use.
    fake.failOn((req) =>
      req.method === 'PATCH' && /\/v1\/blocks\/[^/]+\/children$/.test(req.path)
        ? new FakeNotionResponseError(500, 'internal_server_error', 'boom')
        : undefined,
    )
    const result = await Effect.runPromiseExit(
      sync(
        <Page>
          <ChildPage title="big">{manyParagraphs}</ChildPage>
        </Page>,
        {
          pageId: ROOT,
          cache,
        },
      ).pipe(Effect.provide(fake.layer)),
    )
    // The sync must fail because the tail append errored out.
    expect(result._tag).toBe('Failure')
    // The new page must have been archived as part of the rollback.
    const createdPages = [...fake.pages.values()]
    expect(createdPages).toHaveLength(1)
    expect(createdPages[0]!.in_trash).toBe(true)
  })

  it('phase 3c: idempotent deep sync (Page → ChildPage → Paragraph → Toggle → Paragraph)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <ChildPage blockKey="c" title="doc">
          <Paragraph blockKey="p1">outer</Paragraph>
          <Toggle blockKey="t1" title="fold">
            <Paragraph blockKey="p2">inner</Paragraph>
          </Toggle>
        </ChildPage>
      </Page>
    )
    await runSync(fake, tree, cache)
    const before = fake.requests.length
    const second = await runSync(fake, tree, cache)
    expect(second.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: second.appends,
      inserts: second.inserts,
      updates: second.updates,
      removes: second.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
    const after = fake.requests.slice(before)
    expect(after.filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('phase 3c: nested-page mutation → 1 scoped block update, 0 page ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage blockKey="c" title="doc">
          <Paragraph blockKey="p">v1</Paragraph>
        </ChildPage>
      </Page>,
      cache,
    )
    // Locate the sub-page id from the fake pages map.
    const subPageId = [...fake.pages.values()][0]!.id
    const before = fake.requests.length
    const res = await runSync(
      fake,
      <Page>
        <ChildPage blockKey="c" title="doc">
          <Paragraph blockKey="p">v2</Paragraph>
        </ChildPage>
      </Page>,
      cache,
    )
    expect(res.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect(res.updates).toBe(1)
    expect(res.appends + res.inserts + res.removes).toBe(0)
    // The single update targets a block whose parent is the sub-page id — i.e.
    // a paragraph under the sub-page, not a root-level block.
    const after = fake.requests.slice(before)
    const blockPatches = after.filter(
      (r) => r.method === 'PATCH' && /^\/v1\/blocks\/[^/]+$/.test(r.path),
    )
    expect(blockPatches).toHaveLength(1)
    const updatedBlockId = blockPatches[0]!.path.match(/^\/v1\/blocks\/([^/]+)$/)![1]!
    const updated = fake.blocks.get(updatedBlockId)
    expect(updated?.parent).toBe(subPageId)
  })

  it('phase 3c: page-within-page creates both, block under innermost only', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const t1 = (
      <Page>
        <ChildPage blockKey="A" title="outer">
          <ChildPage blockKey="B" title="inner">
            <Paragraph blockKey="p">body</Paragraph>
          </ChildPage>
        </ChildPage>
      </Page>
    )
    const r1 = await runSync(fake, t1, cache)
    expect(r1.pages.creates).toBe(2)
    // Both pages exist; the paragraph is a child of the inner page.
    expect(fake.pages.size).toBe(2)
    const pages = [...fake.pages.values()]
    const outer = pages.find((p) => p.properties.title.title[0]?.text.content === 'outer')!
    const inner = pages.find((p) => p.properties.title.title[0]?.text.content === 'inner')!
    const paragraphs = [...fake.blocks.values()].filter((b) => b.type === 'paragraph')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0]!.parent).toBe(inner.id)

    // Re-render identical → 0 ops.
    const before = fake.requests.length
    const r2 = await runSync(fake, t1, cache)
    expect(r2.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect(r2.appends + r2.inserts + r2.updates + r2.removes).toBe(0)
    expect(fake.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([])

    // Rename inner → 1 updatePage on the inner page, 0 block/outer ops.
    const t2 = (
      <Page>
        <ChildPage blockKey="A" title="outer">
          <ChildPage blockKey="B" title="inner-renamed">
            <Paragraph blockKey="p">body</Paragraph>
          </ChildPage>
        </ChildPage>
      </Page>
    )
    const r3 = await runSync(fake, t2, cache)
    expect(r3.pages).toMatchObject({ creates: 0, updates: 1, archives: 0, moves: 0 })
    expect(r3.appends + r3.inserts + r3.updates + r3.removes).toBe(0)
    // The updatePage targeted the inner page id.
    const pagePatches = fake.requests.filter(
      (r) => r.method === 'PATCH' && /^\/v1\/pages\/[^/]+$/.test(r.path),
    )
    const lastPatch = pagePatches[pagePatches.length - 1]!
    expect(lastPatch.path).toBe(`/v1/pages/${inner.id}`)
    // Outer page untouched.
    expect(outer.properties.title.title[0]?.text.content).toBe('outer')
  })

  it('phase 3c: archive cascade — archiving outer <ChildPage> issues no block ops on the inner', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage blockKey="A" title="outer">
          <ChildPage blockKey="B" title="inner">
            <Paragraph>body</Paragraph>
          </ChildPage>
        </ChildPage>
      </Page>,
      cache,
    )
    const before = fake.requests.length
    // Drop the outer subtree entirely → single archivePage on outer. The
    // inner sub-page's blocks stay as-is (orphaned alongside the archived
    // outer); no block-scope ops are emitted against them.
    const res = await runSync(fake, <Page />, cache)
    expect(res.pages).toMatchObject({ archives: 1 })
    expect(res.appends + res.inserts + res.updates + res.removes).toBe(0)
    const after = fake.requests.slice(before)
    const blockPatches = after.filter(
      (r) => r.method === 'PATCH' && /^\/v1\/blocks\/[^/]+$/.test(r.path),
    )
    const blockDeletes = after.filter(
      (r) => r.method === 'DELETE' && /^\/v1\/blocks\/[^/]+$/.test(r.path),
    )
    expect(blockPatches).toHaveLength(0)
    expect(blockDeletes).toHaveLength(0)
  })

  it('phase 3c: blockKey namespace isolation — same key under root vs sub-page do not collide', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <Toggle blockKey="k1" title="root-toggle">
          <Paragraph>root-body</Paragraph>
        </Toggle>
        <ChildPage blockKey="c" title="doc">
          <Toggle blockKey="k1" title="sub-toggle">
            <Paragraph>sub-body</Paragraph>
          </Toggle>
        </ChildPage>
      </Page>
    )
    // Cold sync must not throw on duplicate blockKey=k1 (scopes are per-parent).
    await runSync(fake, tree, cache)
    // Warm sync: both keys retain against their own scope's cache → 0 ops.
    const before = fake.requests.length
    const res = await runSync(fake, tree, cache)
    expect(res.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect(res.appends + res.inserts + res.updates + res.removes).toBe(0)
    expect(fake.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('phase 3c: cache v2 → v3 fallback (InMemoryCache with hand-built v2 tree)', async () => {
    const fake = createFakeNotion()
    // Hand-build a v2 cache tree: schemaVersion=2, a stale block entry.
    const v2: CacheTree = {
      schemaVersion: 2,
      rootId: ROOT,
      children: [
        {
          key: 'k:stale',
          blockId: '99999999-1111-4111-8111-000000000000',
          type: 'paragraph',
          hash: 'stale',
          children: [],
          nodeKind: 'block',
        },
      ],
    }
    const cache = InMemoryCache.make(v2)
    const res = await runSync(
      fake,
      <Page>
        <Paragraph blockKey="fresh">hi</Paragraph>
      </Page>,
      cache,
    )
    // The schema bump means the prior cache is treated as v2, which differs
    // from the current CACHE_SCHEMA_VERSION. Expect fallbackReason to be set.
    expect(CACHE_SCHEMA_VERSION).toBe(3)
    expect(res.fallbackReason).toBe('schema-mismatch')
  })

  it('phase 3c: >100 children under a new sub-page land via tail appends scoped to the new page', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const many = Array.from({ length: 105 }, (_, i) => (
      <Paragraph key={String(i)} blockKey={`p${i}`}>{`p${i}`}</Paragraph>
    ))
    const res = await runSync(
      fake,
      <Page>
        <ChildPage blockKey="c" title="big">
          {many}
        </ChildPage>
      </Page>,
      cache,
    )
    expect(res.pages.creates).toBe(1)
    // The 5 overflow paragraphs came through the tail path; all 105 are
    // present under the new sub-page.
    const subPage = [...fake.pages.values()][0]!
    const kids = fake.childrenOf(subPage.id)
    expect(kids.filter((k) => k.type === 'paragraph')).toHaveLength(105)
    // Idempotent warm sync.
    const before = fake.requests.length
    const r2 = await runSync(
      fake,
      <Page>
        <ChildPage blockKey="c" title="big">
          {many}
        </ChildPage>
      </Page>,
      cache,
    )
    expect(r2.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect(r2.appends + r2.inserts + r2.updates + r2.removes).toBe(0)
    expect(fake.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('phase 3c: inline depth 3 under new <ChildPage> — level 3 tails as block.append under inner parent', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Depth-3 structure: ChildPage → Toggle → Toggle → Paragraph.
    // `inlinePackChildren` carries depths 1–2 on the pages.create body; the
    // level-3 paragraph tails as a block.append op under the inner toggle's
    // tmp id, which resolves on apply.
    await runSync(
      fake,
      <Page>
        <ChildPage blockKey="c" title="deep">
          <Toggle title="t1">
            <Toggle title="t2">
              <Paragraph>leaf</Paragraph>
            </Toggle>
          </Toggle>
        </ChildPage>
      </Page>,
      cache,
    )
    // Assert the paragraph materialized at depth 3 under the sub-page.
    const subPage = [...fake.pages.values()][0]!
    const t1 = fake.childrenOf(subPage.id).find((b) => b.type === 'toggle')!
    const t2 = fake.childrenOf(t1.id).find((b) => b.type === 'toggle')!
    const leaf = fake.childrenOf(t2.id).find((b) => b.type === 'paragraph')
    expect(leaf).toBeDefined()
  })

  it('cover: only external / file_upload accepted; emoji-shaped cover is rejected at the boundary', () => {
    // Compile-time: `cover={{ type: 'emoji', emoji: 'x' }}` on <ChildPage/>
    // or <Page/> is a TypeScript error because `PageCover` is narrower than
    // `PageIcon` (no emoji/custom_emoji). Runtime sanity: feeding a bogus
    // shape directly to the normalizer yields `undefined` rather than
    // letting it flow through to the wire.
    expect(projectCover({ type: 'external', external: { url: 'https://x/c.png' } })).toEqual({
      type: 'external',
      external: { url: 'https://x/c.png' },
    })
    expect(projectCover({ type: 'file_upload', file_upload: { id: 'abc' } })).toEqual({
      type: 'file_upload',
      file_upload: { id: 'abc' },
    })
    expect(normalizeCover({ type: 'emoji', emoji: 'x' })).toBeUndefined()
    expect(normalizeCover(null)).toBeUndefined()
  })

  /**
   * Regression for the phase-3d idempotency bug (issue #618 follow-up): when a
   * `<Page>` mixes a leading `<ChildPage>` with a trailing plain block, the
   * pre-fix driver applied the root-scope block append before `pages.create`,
   * inverting the sibling order on the server. The next warm sync saw a drift
   * (cache in candidate order, server in swapped order) and unretained the
   * `<ChildPage>`, crashing `candidateToCache` on the inner block's tmpId.
   */
  it('idempotent: <Page>[<ChildPage>blk</ChildPage>, <Paragraph>]  → 2nd sync is a no-op', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <ChildPage title="cp">
          <Paragraph>inner</Paragraph>
        </ChildPage>
        <Paragraph>sibling</Paragraph>
      </Page>
    )
    await runSync(fake, tree, cache)
    const second = await runSync(fake, tree, cache)
    expect(second.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: second.appends,
      inserts: second.inserts,
      updates: second.updates,
      removes: second.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
  })

  /**
   * Regression for the cross-parent `pages.move` race (issue #618 phase 3d
   * follow-up): reparenting a `<ChildPage>` between two sibling parents in a
   * single sync used to emit both an `archivePage` (from the outgoing
   * parent's `diffChildren` removes loop) and a `movePage` (from the
   * incoming parent's candidate loop) for the same page. The sync driver
   * applied both, leaving the end state order-dependent. Fix: pre-claim
   * cross-parent moves in a whole-tree pass before per-parent emission.
   */
  it('reparent: moving <ChildPage> across sibling parents emits only movePage', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runSync(
      fake,
      <Page>
        <ChildPage blockKey="A" title="A">
          <ChildPage blockKey="m" title="moveable" />
        </ChildPage>
        <ChildPage blockKey="B" title="B" />
      </Page>,
      cache,
    )
    const res = await runSync(
      fake,
      <Page>
        <ChildPage blockKey="A" title="A" />
        <ChildPage blockKey="B" title="B">
          <ChildPage blockKey="m" title="moveable" />
        </ChildPage>
      </Page>,
      cache,
    )
    expect(res.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 1 })
    expect(res.appends + res.inserts + res.updates + res.removes).toBe(0)
  })

  /**
   * Probe for latent nested-scope variant of the phase-3d bug-A interleaving
   * risk: the root-pass interleaves createPage with block ops, but each nested
   * `<ChildPage>` scope still applies its own per-parent block/page ops. A
   * mixed `<ChildPage>` + plain block sibling set *inside* a retained
   * `<ChildPage>` could hit the same cache-vs-server order mismatch that the
   * root-scope fix addresses, triggering `candidateToCache: unresolved
   * blockId` on the next warm sync.
   */
  it('idempotent: nested <ChildPage>[<ChildPage>, <Paragraph>] warm resync — no unresolved blockId', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <ChildPage title="outer">
          <ChildPage title="inner" />
          <Paragraph>sibling</Paragraph>
        </ChildPage>
      </Page>
    )
    await runSync(fake, tree, cache)
    const second = await runSync(fake, tree, cache)
    expect(second.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: second.appends,
      inserts: second.inserts,
      updates: second.updates,
      removes: second.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
  })

  it('idempotent: <Page>[<Paragraph>, <ChildPage>]  → 2nd sync is a no-op (reverse order)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <Page>
        <Paragraph>sibling</Paragraph>
        <ChildPage title="cp">
          <Paragraph>inner</Paragraph>
        </ChildPage>
      </Page>
    )
    await runSync(fake, tree, cache)
    const second = await runSync(fake, tree, cache)
    expect(second.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect({
      appends: second.appends,
      inserts: second.inserts,
      updates: second.updates,
      removes: second.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
  })
})
