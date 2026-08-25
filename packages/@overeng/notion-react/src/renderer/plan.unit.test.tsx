import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { NotionBlocks, type NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { ChildPage, Heading2, Page, Paragraph, Toggle } from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { plan, sync } from './sync.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A, E>(
  fake: FakeNotion,
  eff: Effect.Effect<A, E, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const doc = (version: 1 | 2): ReactNode => (
  <>
    <Heading2>Stats</Heading2>
    <Paragraph blockKey="summary">{version === 1 ? 'first summary' : 'edited summary'}</Paragraph>
    {version === 2 ? <Paragraph blockKey="extra">brand new paragraph</Paragraph> : null}
    <Toggle blockKey="t1" title="Details">
      <Paragraph>{version === 1 ? 'nested body' : 'nested body v2'}</Paragraph>
    </Toggle>
  </>
)

const pageDoc = (icon: string): ReactNode => (
  <Page title="Root title" icon={{ type: 'emoji', emoji: icon }}>
    <Paragraph blockKey="intro">intro text</Paragraph>
    <ChildPage blockKey="sub" title="Sub page">
      <Paragraph>sub body</Paragraph>
    </ChildPage>
  </Page>
)

describe('plan() — read-only companion to sync()', () => {
  it('(a) cold cache: plan predicts exactly what the subsequent sync applies', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const p = await runWith(fake, plan(doc(1), { pageId: ROOT, cache }))
    expect(p.fallbackReason).toBe('cold-cache')
    expect(p.empty).toBe(false)
    const res = await runWith(fake, sync(doc(1), { pageId: ROOT, cache }))
    expect({
      appends: res.appends,
      updates: res.updates,
      inserts: res.inserts,
      removes: res.removes,
    }).toEqual(p.blocks)
    expect(res.pages).toEqual(p.pages)
  })

  it('(a) warm cache + changed JSX: plan and sync agree on the incremental op set', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(doc(1), { pageId: ROOT, cache }))
    const p = await runWith(fake, plan(doc(2), { pageId: ROOT, cache }))
    expect(p.fallbackReason).toBeUndefined()
    // v1 → v2: 'summary' + nested toggle body update, 'extra' inserted mid-siblings.
    expect(p.blocks).toEqual({ appends: 0, updates: 2, inserts: 1, removes: 0 })
    const res = await runWith(fake, sync(doc(2), { pageId: ROOT, cache }))
    expect({
      appends: res.appends,
      updates: res.updates,
      inserts: res.inserts,
      removes: res.removes,
    }).toEqual(p.blocks)
    expect(res.pages).toEqual(p.pages)
  })

  it('(b) fixpoint: immediately after a successful sync, plan returns zero ops', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(doc(2), { pageId: ROOT, cache }))
    const p = await runWith(fake, plan(doc(2), { pageId: ROOT, cache }))
    expect(p.ops).toEqual([])
    expect(p.empty).toBe(true)
    expect(p.fallbackReason).toBeUndefined()
    expect(p.blocks).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(p.pages).toEqual({ creates: 0, updates: 0, archives: 0, moves: 0, reorders: 0 })
  })

  it('(b) fixpoint covers root-page metadata and sub-pages; icon change is planned as one updatePage', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(pageDoc('🧭'), { pageId: ROOT, cache }))
    const settled = await runWith(fake, plan(pageDoc('🧭'), { pageId: ROOT, cache }))
    expect(settled.empty).toBe(true)

    const changed = await runWith(fake, plan(pageDoc('🚀'), { pageId: ROOT, cache }))
    expect(changed.empty).toBe(false)
    expect(changed.blocks).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    expect(changed.pages).toEqual({ creates: 0, updates: 1, archives: 0, moves: 0, reorders: 0 })
    expect(changed.ops[0]).toMatchObject({ kind: 'updatePage', pageId: ROOT })
    const res = await runWith(fake, sync(pageDoc('🚀'), { pageId: ROOT, cache }))
    expect(res.pages).toEqual(changed.pages)
  })

  it('(c) plan issues zero write calls — GET-only in live mode, nothing at all in cache-only mode', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(doc(1), { pageId: ROOT, cache }))
    const before = fake.requests.length
    await runWith(fake, plan(doc(2), { pageId: ROOT, cache }))
    const during = fake.requests.slice(before)
    expect(during.length).toBeGreaterThan(0) // shallow drift pre-flight
    expect(during.every((r) => r.method === 'GET')).toBe(true)

    const beforeCacheOnly = fake.requests.length
    const p = await runWith(fake, plan(doc(2), { pageId: ROOT, cache, staleness: 'cache-only' }))
    expect(fake.requests.length).toBe(beforeCacheOnly)
    // Same plan as live mode here — no out-of-band drift exists.
    expect(p.blocks).toEqual({ appends: 0, updates: 2, inserts: 1, removes: 0 })
  })

  it('staleness stance: live plan sees out-of-band drift, cache-only plan cannot', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(doc(1), { pageId: ROOT, cache }))
    // Another client appends a block behind the cache's back.
    await runWith(
      fake,
      NotionBlocks.append({
        blockId: ROOT,
        children: [{ type: 'paragraph', paragraph: { rich_text: [] } }] as never,
      }),
    )
    const live = await runWith(fake, plan(doc(1), { pageId: ROOT, cache }))
    expect(live.fallbackReason).toBe('cache-drift')
    expect(live.blocks.removes).toBeGreaterThan(0) // the foreign block gets cleaned up
    const blind = await runWith(fake, plan(doc(1), { pageId: ROOT, cache, staleness: 'cache-only' }))
    expect(blind.empty).toBe(true) // trusts the cache, so it cannot see the drift
    // sync converges the drift; plan agrees the fixpoint is restored.
    await runWith(fake, sync(doc(1), { pageId: ROOT, cache }))
    const after = await runWith(fake, plan(doc(1), { pageId: ROOT, cache }))
    expect(after.empty).toBe(true)
  })
})
