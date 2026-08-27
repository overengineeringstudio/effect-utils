import { Effect } from 'effect'
import type { HttpClient } from 'effect/unstable/http/HttpClient'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { ChildPage, Page, Paragraph } from '../components/blocks.ts'
import { createFakeNotion, FakeNotionResponseError, type FakeNotion } from '../test/mock-client.ts'
import { NotionSyncError } from './errors.ts'
import { plan, sync } from './sync.ts'

/**
 * #1124: `pageLifecycle: 'append-only'` — the sync must fail BEFORE any op
 * applies whenever the computed plan implies page destruction, reparenting,
 * reordering, or an out-of-tail create. Every violation-class test asserts
 * zero writes on the mock request log: the enforcement point is a plan
 * predicate, not a mid-apply guard (the downstream lesson this issue
 * absorbs: "a late counter guard is not an apply boundary").
 */
const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A, E>(
  fake: FakeNotion,
  eff: Effect.Effect<A, E, HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

/** Mutating request count — GETs (pre-flight, adoption reads) are allowed. */
const writeCount = (fake: FakeNotion): number =>
  fake.requests.filter((r) => r.method !== 'GET').length

const failingSync = (
  fake: FakeNotion,
  element: ReactNode,
  cache: ReturnType<typeof InMemoryCache.make>,
): Promise<NotionSyncError> =>
  runWith(
    fake,
    Effect.flip(sync(element, { pageId: ROOT, cache, pageLifecycle: 'append-only' })),
  ) as Promise<NotionSyncError>

const TWO_PAGES = (
  <Page>
    <ChildPage blockKey="a" title="A" />
    <ChildPage blockKey="b" title="B" />
  </Page>
)

/** Warm state: two child pages (A, B) synced under the root in managed mode. */
const warmTwoPages = async () => {
  const fake = createFakeNotion()
  const cache = InMemoryCache.make()
  await runWith(fake, sync(TWO_PAGES, { pageId: ROOT, cache }))
  return { fake, cache }
}

describe("pageLifecycle: 'append-only' (#1124)", () => {
  it('tail create is legal: a new page after the retained run is created', async () => {
    const { fake, cache } = await warmTwoPages()
    const res = await runWith(
      fake,
      sync(
        <Page>
          <ChildPage blockKey="a" title="A" />
          <ChildPage blockKey="b" title="B" />
          <ChildPage blockKey="c" title="C" />
        </Page>,
        { pageId: ROOT, cache, pageLifecycle: 'append-only' },
      ),
    )
    expect(res.pages).toMatchObject({ creates: 1, archives: 0, moves: 0 })
    expect([...fake.pages.values()].filter((p) => !p.archived)).toHaveLength(3)
  })

  it('block ops and page content stay fully managed', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(
      fake,
      sync(
        <Page title="v1">
          <Paragraph blockKey="p">one</Paragraph>
          <ChildPage blockKey="a" title="A" />
        </Page>,
        { pageId: ROOT, cache },
      ),
    )
    const res = await runWith(
      fake,
      sync(
        <Page title="v2" icon={{ type: 'emoji', emoji: '📎' }}>
          <Paragraph blockKey="p">two</Paragraph>
          <ChildPage blockKey="a" title="A renamed" />
        </Page>,
        { pageId: ROOT, cache, pageLifecycle: 'append-only' },
      ),
    )
    // Root metadata + sub-page metadata updates and the block update all
    // applied; no lifecycle op was needed or blocked.
    expect(res.updates).toBe(1)
    expect(res.pages).toMatchObject({ updates: 2, creates: 0, archives: 0, moves: 0 })
  })

  it('archive: removing a page from the JSX fails the whole sync with zero writes', async () => {
    const { fake, cache } = await warmTwoPages()
    const before = writeCount(fake)
    const err = await failingSync(
      fake,
      <Page>
        <ChildPage blockKey="a" title="A" />
      </Page>,
      cache,
    )
    expect(err).toBeInstanceOf(NotionSyncError)
    expect(err.reason).toBe('page-lifecycle-violation')
    expect(err.violations?.map((v) => v.kind)).toEqual(['archivePage'])
    expect(writeCount(fake)).toBe(before)
    expect([...fake.pages.values()].filter((p) => !p.archived)).toHaveLength(2)
  })

  it('move: reparenting a page fails pre-mutation with the movePage op attached', async () => {
    const { fake, cache } = await warmTwoPages()
    const before = writeCount(fake)
    const err = await failingSync(
      fake,
      <Page>
        <ChildPage blockKey="a" title="A">
          <ChildPage blockKey="b" title="B" />
        </ChildPage>
      </Page>,
      cache,
    )
    expect(err.reason).toBe('page-lifecycle-violation')
    expect(err.violations?.map((v) => v.kind)).toContain('movePage')
    expect(writeCount(fake)).toBe(before)
  })

  it('reorder: reshuffled retained siblings fail pre-mutation', async () => {
    const { fake, cache } = await warmTwoPages()
    const before = writeCount(fake)
    const err = await runWith(
      fake,
      Effect.flip(
        sync(
          <Page>
            <ChildPage blockKey="b" title="B" />
            <ChildPage blockKey="a" title="A" />
          </Page>,
          { pageId: ROOT, cache, pageLifecycle: 'append-only', reorderSiblings: true },
        ),
      ),
    )
    expect((err as NotionSyncError).reason).toBe('page-lifecycle-violation')
    expect((err as NotionSyncError).violations?.map((v) => v.kind)).toEqual(['reorderPages'])
    expect(writeCount(fake)).toBe(before)
  })

  it('mid-list create: a new page before a retained sibling fails pre-mutation', async () => {
    const { fake, cache } = await warmTwoPages()
    const before = writeCount(fake)
    const err = await failingSync(
      fake,
      <Page>
        <ChildPage blockKey="new" title="New first" />
        <ChildPage blockKey="a" title="A" />
        <ChildPage blockKey="b" title="B" />
      </Page>,
      cache,
    )
    expect(err.reason).toBe('page-lifecycle-violation')
    expect(err.violations?.map((v) => v.kind)).toEqual(['createPage'])
    expect(writeCount(fake)).toBe(before)
    expect(fake.pages.size).toBe(2)
  })

  it("plan() reports the same violations without failing; 'managed' omits the field", async () => {
    const { fake, cache } = await warmTwoPages()
    const removal = (
      <Page>
        <ChildPage blockKey="a" title="A" />
      </Page>
    )
    const preview = await runWith(
      fake,
      plan(removal, { pageId: ROOT, cache, pageLifecycle: 'append-only' }),
    )
    expect(preview.lifecycleViolations?.map((v) => v.kind)).toEqual(['archivePage'])
    // plan() never fails on violations and never writes.
    expect(preview.pages.archives).toBe(1)
    const managed = await runWith(fake, plan(removal, { pageId: ROOT, cache }))
    expect(managed.lifecycleViolations).toBeUndefined()
    // Default mode is unaffected: the same element syncs fine under 'managed'.
    const res = await runWith(fake, sync(removal, { pageId: ROOT, cache }))
    expect(res.pages.archives).toBe(1)
  })

  it('#1100 crash recovery stays legal: pending adoption is not a lifecycle op', async () => {
    const CRASH_TREE = (
      <Page>
        <ChildPage blockKey="child" title="child">
          <Paragraph blockKey="body">body</Paragraph>
        </ChildPage>
      </Page>
    )
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    let tripped = false
    fake.failOn((request) => {
      if (!tripped && request.method === 'GET' && request.path !== `/v1/blocks/${ROOT}/children`) {
        tripped = true
        return new FakeNotionResponseError(500, 'internal_server_error', 'simulated process death')
      }
      return undefined
    })
    const first = await Effect.runPromiseExit(
      sync(CRASH_TREE, { pageId: ROOT, cache, pageLifecycle: 'append-only' }).pipe(
        Effect.provide(fake.layer),
      ),
    )
    expect(first._tag).toBe('Failure')
    const checkpoint = await Effect.runPromise(cache.load)
    expect(checkpoint?.children.find((n) => n.pendingInlineResolution !== undefined)).toBeDefined()
    // Retry with the SAME tree: adoption (read + cache-save) resolves the
    // pending marker and the sync converges without a page mutation.
    const retry = await runWith(
      fake,
      sync(CRASH_TREE, { pageId: ROOT, cache, pageLifecycle: 'append-only' }),
    )
    expect(retry.pages).toMatchObject({ creates: 0, archives: 0, moves: 0 })
    const resolved = await Effect.runPromise(cache.load)
    expect(resolved?.children.find((n) => n.pendingInlineResolution !== undefined)).toBeUndefined()
  })

  it('#1100 checkpointed page that MOVED in the retry JSX: adopted first, then rejected', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Warm state: 'host' exists (so the retry's relocation diffs as a
    // movePage into a RETAINED parent, not archive + re-create).
    await runWith(
      fake,
      sync(
        <Page>
          <ChildPage blockKey="host" title="host" />
        </Page>,
        { pageId: ROOT, cache },
      ),
    )
    const pagesBeforeCrash = fake.pages.size
    let tripped = false
    fake.failOn((request) => {
      if (
        !tripped &&
        fake.pages.size > pagesBeforeCrash &&
        request.method === 'GET' &&
        request.path !== `/v1/blocks/${ROOT}/children`
      ) {
        tripped = true
        return new FakeNotionResponseError(500, 'internal_server_error', 'simulated process death')
      }
      return undefined
    })
    // Tail-legal create of 'child' crashes after pages.create checkpointed
    // its identity but before the inline-descendant retrieval landed.
    const first = await Effect.runPromiseExit(
      sync(
        <Page>
          <ChildPage blockKey="host" title="host" />
          <ChildPage blockKey="child" title="child">
            <Paragraph blockKey="body">body</Paragraph>
          </ChildPage>
        </Page>,
        { pageId: ROOT, cache, pageLifecycle: 'append-only' },
      ).pipe(Effect.provide(fake.layer)),
    )
    expect(first._tag).toBe('Failure')
    const before = writeCount(fake)
    // Retry JSX relocated the checkpointed page under the retained host. The
    // cross-parent adoption binds the created identity (harmless: read +
    // cache-save), then the post-diff predicate rejects the implied move.
    const err = await failingSync(
      fake,
      <Page>
        <ChildPage blockKey="host" title="host">
          <ChildPage blockKey="child" title="child">
            <Paragraph blockKey="body">body</Paragraph>
          </ChildPage>
        </ChildPage>
      </Page>,
      cache,
    )
    expect(err.reason).toBe('page-lifecycle-violation')
    expect(err.violations?.map((v) => v.kind)).toContain('movePage')
    // Adoption resolved the pending marker in the cache…
    const resolved = await Effect.runPromise(cache.load)
    expect(resolved?.children.find((n) => n.pendingInlineResolution !== undefined)).toBeUndefined()
    // …but no server write happened on the retry.
    expect(writeCount(fake)).toBe(before)
  })
})
