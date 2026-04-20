import type { HttpClient } from '@effect/platform'
import { Effect, Exit } from 'effect'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { ColumnList, Paragraph, Toggle } from '../components/blocks.tsx'
import { h } from '../components/h.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { buildCandidateTree, diff, tallyDiff } from './sync-diff.ts'
import { sync } from './sync.ts'

/**
 * Boundary-condition tests for Notion API limits that the renderer/sync
 * driver has to respect in v0.1. Where the current implementation does NOT
 * yet enforce a given boundary (e.g. the 2000-char rich_text limit, or
 * batching of >100 children per append request), we pin the observed
 * behaviour here so the gap is visible in the test suite. Each such case is
 * flagged with an `XXX` comment referencing #95.
 */
const ROOT = '00000000-0000-4000-8000-0000000000aa'

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const runWithExit = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<Exit.Exit<A, unknown>> =>
  Effect.runPromise(eff.pipe(Effect.provide(fake.layer), Effect.exit))

describe('pagination + batch boundaries', () => {
  it('rich_text >2000 chars is chunked into ≤2000-char segments (#100)', () => {
    // Notion's API limits each rich_text `text` segment to 2000 chars per
    // entry. The renderer splits longer content into multiple segments that
    // share the annotation/link envelope. See `flattenRichText` tests for
    // annotation preservation across chunks.
    const long = 'a'.repeat(2500)
    const candidate = buildCandidateTree(<Paragraph>{long}</Paragraph>, ROOT)
    expect(candidate.children).toHaveLength(1)
    const rt = candidate.children[0]!.props.rich_text as {
      text: { content: string }
    }[]
    expect(rt).toHaveLength(2)
    expect(rt[0]!.text.content).toHaveLength(2000)
    expect(rt[1]!.text.content).toHaveLength(500)
    expect(rt.map((r) => r.text.content).join('')).toBe(long)
  })

  it('>100 siblings append each flow through the API without renderer-side batching', async () => {
    // Notion caps `append` at 100 children per request; the current sync
    // driver issues one API call per op, so 150 candidate siblings
    // materialize as 150 separate POSTs. Assert the per-op shape and the
    // resulting server state.
    //
    // XXX: Renderer does not coalesce consecutive appends under the same
    // parent into batched API requests. Tracked as follow-up for #95.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const paragraphs: ReactNode[] = []
    for (let i = 0; i < 150; i++) {
      paragraphs.push(
        <Fragment key={i}>{h('paragraph', { blockKey: `p${i}` }, `line ${i}`)}</Fragment>,
      )
    }
    const res = await runWith(
      fake,
      sync(<>{paragraphs}</>, { pageId: ROOT, cache }).pipe(
        Effect.mapError((cause) => new Error(String(cause))),
      ),
    )
    expect(res).toMatchObject({ appends: 150, updates: 0, inserts: 0, removes: 0 })
    // `NotionBlocks.append` issues PATCH against `/v1/blocks/{id}/children`
    // (the Notion API actually accepts either POST or PATCH for append; the
    // Effect client uses PATCH). The mock client stubs both.
    const appendReqs = fake.requests.filter(
      (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${ROOT}/children`,
    )
    expect(appendReqs.length).toBeGreaterThanOrEqual(2)
    expect(appendReqs.length).toBe(150)
    expect(fake.childrenOf(ROOT)).toHaveLength(150)
  })

  describe('empty containers render cleanly', () => {
    it('empty Toggle projects as a single append with no nested children', () => {
      const candidate = buildCandidateTree(<Toggle title="t" />, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 1, updates: 0, inserts: 0, removes: 0 })
      expect(candidate.children[0]!.children).toHaveLength(0)
    })

    it('empty Column inside ColumnList → 2 appends (column_list + column)', () => {
      const candidate = buildCandidateTree(<ColumnList>{h('column', null)}</ColumnList>, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 2, updates: 0, inserts: 0, removes: 0 })
    })

    it('empty ColumnList (no columns) → 1 append, no children', () => {
      const candidate = buildCandidateTree(<ColumnList>{null}</ColumnList>, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 1, updates: 0, inserts: 0, removes: 0 })
      expect(candidate.children[0]!.children).toHaveLength(0)
    })
  })

  it('mid-batch failure: cache rolls back, server retains partial writes', async () => {
    // The sync driver runs all ops inside a single Effect.gen; the first
    // failing API call short-circuits the whole Effect, so `cache.save`
    // never runs.
    //
    // Concretely: server-side the mock retains the first 50 appended
    // blocks (partial persistence on the upstream), but our local cache
    // stays whatever it was BEFORE the failed sync (empty here). This is
    // the "all-or-nothing from the cache's perspective" behaviour and the
    // most important signal for v0.1 — a subsequent retry will diff
    // against an empty cache and attempt to re-append all 100 blocks,
    // duplicating the 50 already on the server.
    //
    // XXX: Partial-server / empty-cache on failure means retries
    // duplicate server state. Tracked as follow-up for #95.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const paragraphs: ReactNode[] = []
    for (let i = 0; i < 100; i++) {
      paragraphs.push(
        <Fragment key={i}>{h('paragraph', { blockKey: `p${i}` }, `line ${i}`)}</Fragment>,
      )
    }
    // Count only POST append requests so the boundary is unambiguous —
    // the handler records *all* requests, and the 51st POST is the one
    // we want to fail.
    let appendCount = 0
    fake.failOn((req) => {
      if (req.method === 'PATCH' && req.path === `/v1/blocks/${ROOT}/children`) {
        appendCount += 1
        if (appendCount === 51) return new Error('fake-notion: simulated upstream failure at op 51')
      }
      return undefined
    })

    const exit = await runWithExit(fake, sync(<>{paragraphs}</>, { pageId: ROOT, cache }))
    expect(Exit.isFailure(exit)).toBe(true)
    // Server state: first 50 appends landed.
    expect(fake.childrenOf(ROOT)).toHaveLength(50)
    // Cache state: untouched (no save on failure).
    const cached = await Effect.runPromise(cache.load)
    expect(cached).toBeUndefined()
  })

  // Performance benchmarks need a different harness (timing reliability in
  // CI, warmup, budget thresholds). Deferred per #95; skip for now.
  it.skip('large-page cold sync perf target 2x flush time (#95)', () => {})
})
