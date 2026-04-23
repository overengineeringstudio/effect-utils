import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionBlocks, type NotionConfig, NotionPages } from '@overeng/notion-effect-client'

import { createFakeNotion, type FakeNotion } from './mock-client.ts'

/**
 * Stateful FakePage contract (issue #618 phase 3a).
 *
 * These tests pin down the behavior the renderer-level page-ops work depends
 * on in phase 3b/3c: page state is actually retained in memory across
 * requests, archive/restore round-trips through `in_trash`, moving reparents
 * the page, and block-side endpoints coherently reflect page-archival state.
 */

const runWith = <A>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const PARENT_ID = '11111111-1111-4111-8111-0000000000aa'

describe('FakeNotion stateful page model', () => {
  it('POST /v1/pages allocates a page and auto-materializes a child_page block under the parent', async () => {
    const fake = createFakeNotion()
    const page = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: PARENT_ID },
        properties: {
          title: { title: [{ type: 'text', text: { content: 'Hello' } }] },
        },
      }),
    )
    expect(page.id).toMatch(/^11111111-/)
    expect(fake.pages.get(page.id)).toBeDefined()
    // Auto-materialized child_page block (A06) — shows up under the parent.
    const children = fake.childrenOf(PARENT_ID)
    expect(children.map((b) => ({ id: b.id, type: b.type }))).toEqual([
      { id: page.id, type: 'child_page' },
    ])
  })

  it('PATCH /v1/pages merges title, icon, and cover across calls (state is retained)', async () => {
    const fake = createFakeNotion()
    const created = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: PARENT_ID },
        properties: { title: { title: [{ type: 'text', text: { content: 'v1' } }] } },
      }),
    )
    // Patch title
    await runWith(
      fake,
      NotionPages.update({
        pageId: created.id,
        properties: { title: { title: [{ type: 'text', text: { content: 'v2' } }] } },
      }),
    )
    // Patch icon + cover in a separate call — title must be preserved.
    await runWith(
      fake,
      NotionPages.update({
        pageId: created.id,
        icon: { type: 'emoji', emoji: '🧪' },
        cover: { type: 'external', external: { url: 'https://x/c.png' } },
      }),
    )
    const stored = fake.pages.get(created.id)!
    expect(stored.properties.title.title[0]!.text.content).toBe('v2')
    expect(stored.icon).toEqual({ type: 'emoji', emoji: '🧪' })
    expect(stored.cover).toEqual({ type: 'external', external: { url: 'https://x/c.png' } })
    expect(fake.pageRequests.length).toBeGreaterThan(0)
    expect(fake.pageRequests.every((r) => r.path.startsWith('/v1/pages'))).toBe(true)
  })

  it('PATCH /v1/pages with {icon: null} / {cover: null} clears the fields (phase 4b #618)', async () => {
    const fake = createFakeNotion()
    const created = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: PARENT_ID },
        properties: { title: { title: [{ type: 'text', text: { content: 'clearable' } }] } },
        icon: { type: 'emoji', emoji: '🧪' },
      }),
    )
    // Initial icon set via create; cover set via first update.
    await runWith(
      fake,
      NotionPages.update({
        pageId: created.id,
        cover: { type: 'external', external: { url: 'https://x/c.png' } },
      }),
    )
    expect(fake.pages.get(created.id)!.icon).not.toBeNull()
    expect(fake.pages.get(created.id)!.cover).not.toBeNull()
    // Now clear both via null. The mock handler treats `icon: null` /
    // `cover: null` as a field clear (mirrors Notion's real behaviour).
    await runWith(
      fake,
      NotionPages.update({
        pageId: created.id,
        icon: null,
        cover: null,
      }),
    )
    const stored = fake.pages.get(created.id)!
    expect(stored.icon).toBeNull()
    expect(stored.cover).toBeNull()
  })

  it('in_trash=true archives; in_trash=false restores; retrieval still returns the archived page', async () => {
    const fake = createFakeNotion()
    const created = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: PARENT_ID },
        properties: { title: { title: [{ type: 'text', text: { content: 'Archivable' } }] } },
      }),
    )
    // Archive.
    await runWith(fake, NotionPages.update({ pageId: created.id, in_trash: true }))
    expect(fake.pages.get(created.id)!.archived).toBe(true)
    // Retrieval on an archived page still succeeds (findings #10).
    const retrieved = await runWith(fake, NotionPages.retrieve({ pageId: created.id }))
    expect(retrieved.in_trash).toBe(true)
    // Listing children on an archived page → 404.
    const listing = await Effect.runPromise(
      NotionBlocks.retrieveChildren({ blockId: created.id }).pipe(
        Effect.provide(fake.layer),
        Effect.either,
      ),
    )
    expect(listing._tag).toBe('Left')
    // Restore.
    await runWith(fake, NotionPages.update({ pageId: created.id, in_trash: false }))
    expect(fake.pages.get(created.id)!.archived).toBe(false)
  })

  it('POST /v1/pages/{id}/move reparents the page (page_id → page_id)', async () => {
    const fake = createFakeNotion()
    const parentA = '11111111-1111-4111-8111-0000000000a1'
    const parentB = '11111111-1111-4111-8111-0000000000b1'
    const created = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: parentA },
        properties: { title: { title: [{ type: 'text', text: { content: 'Movable' } }] } },
      }),
    )
    await runWith(
      fake,
      NotionPages.move({
        pageId: created.id,
        parent: { type: 'page_id', page_id: parentB },
      }),
    )
    const parent = fake.pages.get(created.id)!.parent
    expect(parent).toEqual({ type: 'page_id', page_id: parentB })
  })

  it('GET /v1/blocks/{id} returns the auto-materialized child_page envelope for a page id', async () => {
    const fake = createFakeNotion()
    const created = await runWith(
      fake,
      NotionPages.create({
        parent: { type: 'page_id', page_id: PARENT_ID },
        properties: { title: { title: [{ type: 'text', text: { content: 'X' } }] } },
      }),
    )
    const block = await runWith(fake, NotionBlocks.retrieve({ blockId: created.id }))
    expect(block.type).toBe('child_page')
  })
})
