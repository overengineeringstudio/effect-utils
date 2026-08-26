import { Effect } from 'effect'
/**
 * Fail-closed adoption (#1093). Every test — including every refusal path —
 * asserts zero mutating requests on the mock's request log: adoption is
 * GET-only by contract, in all outcomes.
 */
import type { HttpClient } from 'effect/unstable/http/HttpClient'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { NotionBlocks, NotionPages, type NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import type { CacheTree } from '../cache/types.ts'
import {
  BulletedListItem,
  ChildPage,
  Code,
  Heading2,
  Page,
  Paragraph,
  Raw,
  Toggle,
} from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { adopt, AdoptionRefusedError, type AdoptionRefusal } from './adopt.ts'
import { buildCandidateTree, diff } from './sync-diff.ts'
import { plan, sync } from './sync.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A, E>(
  fake: FakeNotion,
  eff: Effect.Effect<A, E, HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

/**
 * Nontrivial tree: root-page metadata, keyed and unkeyed blocks, nested
 * blocks under a toggle, sibling list items, a child page with icon holding a
 * nested child page, and an unkeyed tail paragraph.
 */
const AdoptionTree = ({ intro = 'intro text' }: { readonly intro?: string }): ReactNode => (
  <Page title="Adoption Root">
    <Heading2>Stats</Heading2>
    <Paragraph blockKey="intro">{intro}</Paragraph>
    <Toggle blockKey="t1" title="Details">
      <Paragraph>nested body</Paragraph>
      <Code language="typescript">{'const x = 1'}</Code>
    </Toggle>
    <BulletedListItem>alpha</BulletedListItem>
    <BulletedListItem>beta</BulletedListItem>
    <ChildPage blockKey="sub" title="Sub Page" icon={{ type: 'emoji', emoji: '📄' }}>
      <Paragraph blockKey="p1">sub content</Paragraph>
      <ChildPage blockKey="subsub" title="Deep Page">
        <Paragraph>deep body</Paragraph>
      </ChildPage>
    </ChildPage>
    <Paragraph>outro</Paragraph>
  </Page>
)

/** Render live state via a normal cold sync, then discard the cache (loss simulation). */
const renderAndDiscardCache = async (element: ReactNode): Promise<FakeNotion> => {
  const fake = createFakeNotion()
  await runWith(fake, sync(element, { pageId: ROOT, cache: InMemoryCache.make() }))
  return fake
}

const mutatingRequestsSince = (fake: FakeNotion, marker: number) =>
  fake.requests.slice(marker).filter((r) => r.method !== 'GET')

const adoptRefusals = async (
  fake: FakeNotion,
  element: ReactNode,
): Promise<readonly AdoptionRefusal[]> => {
  const marker = fake.requests.length
  const err = await runWith(fake, adopt(element, { pageId: ROOT }).pipe(Effect.flip))
  // Fail-closed refusals must also be mutation-free.
  expect(mutatingRequestsSince(fake, marker)).toEqual([])
  expect(err).toBeInstanceOf(AdoptionRefusedError)
  return (err as AdoptionRefusedError).refusals
}

describe('adopt(): fail-closed adoption of an existing rendered page (#1093)', () => {
  it('clean adoption: reconstructed cache equals the organically saved cache, with zero mutations', async () => {
    const fake = createFakeNotion()
    const organic = InMemoryCache.make()
    await runWith(fake, sync(<AdoptionTree />, { pageId: ROOT, cache: organic }))
    const organicTree = await Effect.runPromise(organic.load)
    expect(organicTree).toBeDefined()

    const marker = fake.requests.length
    const adopted = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))
    expect(mutatingRequestsSince(fake, marker)).toEqual([])
    // The adopted cache is byte-equivalent to the cache sync itself persisted.
    expect(adopted).toEqual(organicTree)
  })

  it('adoption fixpoint: plan() over the adopted cache is empty, and sync applies zero ops', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const adopted = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))

    const marker = fake.requests.length
    const p = await runWith(
      fake,
      plan(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(adopted) }),
    )
    expect(p.empty).toBe(true)
    expect(p.fallbackReason).toBeUndefined()

    const res = await runWith(
      fake,
      sync(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(adopted) }),
    )
    expect({
      appends: res.appends,
      inserts: res.inserts,
      updates: res.updates,
      removes: res.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
    expect(res.pages).toMatchObject({ creates: 0, updates: 0, archives: 0, moves: 0 })
    expect(res.fallbackReason).toBeUndefined()
    expect(mutatingRequestsSince(fake, marker)).toEqual([])
  })

  it('pure-diff proof: diff(adoptedCache, candidate) is empty', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const adopted = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))
    const ops = diff(adopted, buildCandidateTree(<AdoptionTree />, ROOT))
    expect(ops).toEqual([])
  })

  it('refuses (a): untracked extra live block → ChildCountMismatch, zero mutations', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    await runWith(
      fake,
      NotionBlocks.append({
        blockId: ROOT,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: 'intruder' } }] },
          },
        ],
      }),
    )
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    const count = refusals.find((r) => r._tag === 'ChildCountMismatch')
    expect(count).toMatchObject({ parentId: ROOT, expected: 7, actual: 8 })
    expect(count && count._tag === 'ChildCountMismatch' && count.untrackedLiveIds).toHaveLength(1)
  })

  it('refuses (a2): untracked NESTED live content under a leaf-expected block → ChildCountMismatch at that parent', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    // Out-of-band nested append under the tail paragraph (candidate expects a leaf).
    const tail = fake.childrenOf(ROOT).at(-1)!
    await runWith(
      fake,
      NotionBlocks.append({
        blockId: tail.id,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: 'stowaway' } }] },
          },
        ],
      }),
    )
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      _tag: 'ChildCountMismatch',
      parentId: tail.id,
      expected: 0,
      actual: 1,
    })
  })

  it('refuses (b): live type mismatch at a position → TypeMismatch, no content-based rebinding', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    // Replace the tail paragraph ("outro") with a divider, preserving count.
    const tail = fake.childrenOf(ROOT).at(-1)!
    expect(tail.type).toBe('paragraph')
    await runWith(fake, NotionBlocks.delete({ blockId: tail.id }))
    await runWith(
      fake,
      NotionBlocks.append({
        blockId: ROOT,
        children: [{ object: 'block', type: 'divider', divider: {} }],
      }),
    )
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      _tag: 'TypeMismatch',
      parentId: ROOT,
      position: 6,
      expectedType: 'paragraph',
      actualType: 'divider',
    })
  })

  it('refuses (c): out-of-band content edit → ContentDrift pinning key, blockId, and both readback hashes', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const intro = fake.childrenOf(ROOT)[1]!
    fake.blocks.get(intro.id)!.payload = {
      rich_text: [{ type: 'text', text: { content: 'tampered' } }],
    }
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      _tag: 'ContentDrift',
      parentId: ROOT,
      position: 1,
      key: 'k:intro',
      blockId: intro.id,
    })
    const drift = refusals[0]!
    if (drift._tag === 'ContentDrift') {
      expect(drift.candidateHash).not.toBe(drift.observedHash)
    }
  })

  it('refuses (c2): NESTED content drift pins the nested block, not its ancestors', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const toggle = fake.childrenOf(ROOT)[2]!
    expect(toggle.type).toBe('toggle')
    const nested = fake.childrenOf(toggle.id)[0]!
    fake.blocks.get(nested.id)!.payload = {
      rich_text: [{ type: 'text', text: { content: 'tampered nested' } }],
    }
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      _tag: 'ContentDrift',
      parentId: toggle.id,
      position: 0,
      blockId: nested.id,
    })
  })

  it('rule (d1): identical unkeyed siblings bind positionally — deterministic, not a guess', async () => {
    const twins = (
      <>
        <Paragraph>same text</Paragraph>
        <Paragraph>same text</Paragraph>
      </>
    )
    const fake = await renderAndDiscardCache(twins)
    const adopted = await runWith(fake, adopt(twins, { pageId: ROOT }))
    const live = fake.childrenOf(ROOT)
    // Position i in the candidate binds to position i live. Identical siblings
    // are observationally indistinguishable, so the positional binding is the
    // canonical one (any permutation is equivalent); keys stay positional too.
    expect(adopted.children.map((c) => ({ key: c.key, blockId: c.blockId }))).toEqual([
      { key: 'p:0', blockId: live[0]!.id },
      { key: 'p:1', blockId: live[1]!.id },
    ])
  })

  it('refuses (d2): live order swapped against candidate → refusal at both positions, no re-matching by content', async () => {
    const pair = (
      <>
        <Paragraph>alpha body</Paragraph>
        <Heading2>beta title</Heading2>
      </>
    )
    const fake = await renderAndDiscardCache(pair)
    // Out-of-band swap: delete the leading paragraph, re-append it at the
    // tail → live order [heading_2, paragraph] vs candidate [paragraph, heading_2].
    const first = fake.childrenOf(ROOT)[0]!
    await runWith(fake, NotionBlocks.delete({ blockId: first.id }))
    await runWith(
      fake,
      NotionBlocks.append({
        blockId: ROOT,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: 'alpha body' } }] },
          },
        ],
      }),
    )
    const refusals = await adoptRefusals(fake, pair)
    // A content-searching matcher would "find" both blocks; positional
    // fail-closed adoption refuses instead.
    expect(refusals.map((r) => r._tag)).toEqual(['TypeMismatch', 'TypeMismatch'])
  })

  it('refuses (e): live child page missing → ChildCountMismatch (and positional fallout), zero mutations', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const subBlock = fake.childrenOf(ROOT).find((b) => b.type === 'child_page')!
    await runWith(fake, NotionPages.archive({ pageId: subBlock.id }))
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    const count = refusals.find((r) => r._tag === 'ChildCountMismatch')
    expect(count).toMatchObject({ parentId: ROOT, expected: 7, actual: 6 })
  })

  it('refuses: child-page title renamed out-of-band → PageMetaDrift(title)', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const subBlock = fake.childrenOf(ROOT).find((b) => b.type === 'child_page')!
    fake.pages.get(subBlock.id)!.properties = {
      title: { title: [{ type: 'text', text: { content: 'Renamed Out Of Band' } }] },
    }
    const refusals = await adoptRefusals(fake, <AdoptionTree />)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      _tag: 'PageMetaDrift',
      pageId: subBlock.id,
      key: 'k:sub',
      field: 'title',
    })
  })

  it('refuses: <Raw> content is unverifiable through the readback oracle → UnverifiableContent', async () => {
    const withRaw = (
      <>
        <Paragraph>lead</Paragraph>
        <Raw type="breadcrumb" content={{}} />
      </>
    )
    const fake = await renderAndDiscardCache(withRaw)
    const refusals = await adoptRefusals(fake, withRaw)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ _tag: 'UnverifiableContent', parentId: ROOT, position: 1 })
  })

  it('recovery: adopt-live on content drift, then one sync repairs with exactly one update, then fail-closed adoption succeeds', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const intro = fake.childrenOf(ROOT)[1]!
    fake.blocks.get(intro.id)!.payload = {
      rich_text: [{ type: 'text', text: { content: 'tampered' } }],
    }

    // Step 1: default adoption refuses (fail-closed baseline).
    await adoptRefusals(fake, <AdoptionTree />)

    // Step 2: explicit opt-in adopts STRUCTURE, records the live marker at
    // the drifted node, still performs zero mutations.
    const marker = fake.requests.length
    const adopted = await runWith(
      fake,
      adopt(<AdoptionTree />, { pageId: ROOT, onContentDrift: 'adopt-live' }),
    )
    expect(mutatingRequestsSince(fake, marker)).toEqual([])

    // Step 3: a normal sync against the adopted cache emits exactly the one
    // update needed to repair the drifted paragraph — no removes, no appends.
    const res = await runWith(
      fake,
      sync(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(adopted) }),
    )
    expect({
      appends: res.appends,
      inserts: res.inserts,
      updates: res.updates,
      removes: res.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 1, removes: 0 })
    expect(JSON.stringify(fake.blocks.get(intro.id)!.payload)).toContain('intro text')

    // Step 4: the repaired page now passes strict fail-closed adoption and
    // reaches the zero-op fixpoint.
    const readopted = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))
    const res2 = await runWith(
      fake,
      sync(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(readopted) }),
    )
    expect({
      appends: res2.appends,
      inserts: res2.inserts,
      updates: res2.updates,
      removes: res2.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
  })

  it('recovery: adopt-live on root-title drift, then one sync repairs with exactly one pages.update', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    fake.pages.get(ROOT)!.properties = {
      title: { title: [{ type: 'text', text: { content: 'Renamed Root' } }] },
    }

    // Structural checks stay fail-closed; only the drifted root title records
    // the live hash. Still zero mutations.
    const marker = fake.requests.length
    const adopted = await runWith(
      fake,
      adopt(<AdoptionTree />, { pageId: ROOT, onContentDrift: 'adopt-live' }),
    )
    expect(mutatingRequestsSince(fake, marker)).toEqual([])

    const res = await runWith(
      fake,
      sync(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(adopted) }),
    )
    expect({
      appends: res.appends,
      inserts: res.inserts,
      updates: res.updates,
      removes: res.removes,
    }).toEqual({ appends: 0, inserts: 0, updates: 0, removes: 0 })
    expect(res.pages).toMatchObject({ creates: 0, updates: 1, archives: 0, moves: 0 })
    expect(JSON.stringify(fake.pages.get(ROOT)!.properties)).toContain('Adoption Root')

    // Repaired root now passes strict re-adoption.
    const readopted = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))
    const p = await runWith(
      fake,
      plan(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make(readopted) }),
    )
    expect(p.empty).toBe(true)
  })

  it('contrast: the documented cold path re-renders everything where adoption is a noop', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    // The issue's repro: same live page, fresh cache, default coldBaseline
    // 'clean' → full remove + append churn.
    const cold = await runWith(
      fake,
      sync(<AdoptionTree />, { pageId: ROOT, cache: InMemoryCache.make() }),
    )
    expect(cold.fallbackReason).toBe('cold-cache')
    expect(cold.removes).toBeGreaterThan(0)
    expect(cold.appends).toBeGreaterThan(0)
  })

  it('refuses: archived root → typed RootTrashed, checked BEFORE the block walk (A09)', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    await runWith(fake, NotionPages.archive({ pageId: ROOT }))
    const marker = fake.requests.length
    // AdoptionTree carries <Page title=...> claims — the pre-flight must
    // surface the typed refusal, not NotionSyncError from a 404 on
    // blocks.children.list against an archived page.
    const err = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(AdoptionRefusedError)
    expect((err as AdoptionRefusedError).refusals).toEqual([{ _tag: 'RootTrashed', pageId: ROOT }])
    expect(mutatingRequestsSince(fake, marker)).toEqual([])
  })
})

/** Adopted-cache shape sanity: nested pages carry nodeKind 'page' and verified meta hashes. */
describe('adopt(): adopted cache shape', () => {
  it('binds nested page identities recursively with verified title/icon hashes', async () => {
    const fake = await renderAndDiscardCache(<AdoptionTree />)
    const adopted: CacheTree = await runWith(fake, adopt(<AdoptionTree />, { pageId: ROOT }))
    expect(adopted.rootTitleHash).toBeDefined()
    const sub = adopted.children.find((c) => c.key === 'k:sub')!
    expect(sub.nodeKind).toBe('page')
    expect(sub.titleHash).toBeDefined()
    expect(sub.iconHash).toBeDefined()
    expect(fake.pages.has(sub.blockId)).toBe(true)
    const subsub = sub.children.find((c) => c.key === 'k:subsub')!
    expect(subsub.nodeKind).toBe('page')
    expect(fake.pages.has(subsub.blockId)).toBe(true)
  })
})
