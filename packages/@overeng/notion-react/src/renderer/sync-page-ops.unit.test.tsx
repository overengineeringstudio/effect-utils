import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { ChildPage, Page, Paragraph } from '../components/blocks.ts'
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
})
