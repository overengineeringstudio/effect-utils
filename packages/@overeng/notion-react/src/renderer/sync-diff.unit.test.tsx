import { describe, expect, it } from 'vitest'

import { CACHE_SCHEMA_VERSION, type CacheTree } from '../cache/types.ts'
import { Heading2, Paragraph, Toggle } from '../components/blocks.tsx'
import { h } from '../components/h.ts'
import {
  buildCandidateTree,
  candidateToCache,
  diff,
  stableStringify,
  tallyDiff,
  type CandidateTree,
} from './sync-diff.ts'

const ROOT = 'page-root'

const empty = (): CacheTree => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  rootId: ROOT,
  children: [],
})

/**
 * Fake-apply a diff plan by minting synthetic blockIds for each tmpId. The
 * real applyDiff hits Notion; the diff algorithm is independent of that I/O
 * layer, so we exercise it directly.
 */
const fakeApply = (candidate: CandidateTree, ops: ReturnType<typeof diff>): CacheTree => {
  let counter = 0
  const idMap = new Map<string, string>()
  for (const op of ops) {
    if (op.kind === 'append' || op.kind === 'insert') {
      counter += 1
      idMap.set(op.tmpId, `blk-${counter}`)
    }
  }
  // Resolve tmpIds in candidate to real ids.
  const walk = (children: CandidateTree['children']): void => {
    for (const c of children) {
      if (c.blockId !== undefined && idMap.has(c.blockId)) c.blockId = idMap.get(c.blockId)
      walk(c.children)
    }
  }
  walk(candidate.children)
  return candidateToCache(candidate, CACHE_SCHEMA_VERSION)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kb = (key: string): any => ({ blockKey: key })

describe('sync-diff', () => {
  describe('stableStringify', () => {
    it('produces identical output for objects with same keys in any order', () => {
      expect(stableStringify({ a: 1, b: 2 })).toEqual(stableStringify({ b: 2, a: 1 }))
    })
    it('differs when values differ', () => {
      expect(stableStringify({ a: 1 })).not.toEqual(stableStringify({ a: 2 }))
    })
  })

  it('initial render with empty cache → appends only, count = total blocks', () => {
    const candidate = buildCandidateTree(
      <>
        <Heading2>Title</Heading2>
        <Paragraph>Hello</Paragraph>
        <Toggle title="more">
          <Paragraph>inside</Paragraph>
        </Toggle>
      </>,
      ROOT,
    )
    const ops = diff(empty(), candidate)
    const t = tallyDiff(ops)
    // 3 top-level blocks + 1 nested paragraph under Toggle = 4 appends.
    expect(t).toEqual({ appends: 4, updates: 0, inserts: 0, removes: 0 })
  })

  it('same tree resync → all zeros', () => {
    const element = (
      <>
        <Heading2>Title</Heading2>
        <Paragraph>Hello</Paragraph>
      </>
    )
    const first = buildCandidateTree(element, ROOT)
    const firstOps = diff(empty(), first)
    const cache = fakeApply(first, firstOps)

    const second = buildCandidateTree(element, ROOT)
    const secondOps = diff(cache, second)
    expect(tallyDiff(secondOps)).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 0 })
  })

  it('one-block body change → {updates: 1}', () => {
    const v1 = buildCandidateTree(
      <>
        <Paragraph>v1</Paragraph>
        <Paragraph>stable</Paragraph>
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))

    const v2 = buildCandidateTree(
      <>
        <Paragraph>v2</Paragraph>
        <Paragraph>stable</Paragraph>
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
  })

  it('appended sibling at end → 1 new-block op (append)', () => {
    const v1 = buildCandidateTree(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    const v2 = buildCandidateTree(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
        <Paragraph>c</Paragraph>
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    // Tail-append: emitted as `append`, not `insert`, since Notion's append
    // API is the natural fit at the list tail.
    expect(tallyDiff(ops)).toEqual({ appends: 1, updates: 0, inserts: 0, removes: 0 })
  })

  it('inserted sibling mid → {inserts: 1}', () => {
    const v1 = buildCandidateTree(
      <>
        {h('paragraph', kb('a'), 'a')}
        {h('paragraph', kb('c'), 'c')}
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    const v2 = buildCandidateTree(
      <>
        {h('paragraph', kb('a'), 'a')}
        {h('paragraph', kb('b'), 'b')}
        {h('paragraph', kb('c'), 'c')}
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 0, inserts: 1, removes: 0 })
  })

  it('removed sibling → {removes: 1}', () => {
    const v1 = buildCandidateTree(
      <>
        {h('paragraph', kb('a'), 'a')}
        {h('paragraph', kb('b'), 'b')}
        {h('paragraph', kb('c'), 'c')}
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    const v2 = buildCandidateTree(
      <>
        {h('paragraph', kb('a'), 'a')}
        {h('paragraph', kb('c'), 'c')}
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 1 })
  })

  it('re-order (key stable, position change) → {inserts: 1, removes: 1}', () => {
    // Notion has no move API; a pure swap has to materialize as at least
    // one insert + one remove. Our LCS diff picks the longest in-order
    // subsequence and treats the rest as re-insert.
    const v1 = buildCandidateTree(
      <>
        {h('paragraph', kb('a'), 'a')}
        {h('paragraph', kb('b'), 'b')}
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    const v2 = buildCandidateTree(
      <>
        {h('paragraph', kb('b'), 'b')}
        {h('paragraph', kb('a'), 'a')}
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    // LCS([a,b], [b,a]) = 1 → one key retained, the other removed+re-inserted.
    const t = tallyDiff(ops)
    expect(t.updates).toBe(0)
    expect(t.inserts + t.appends).toBe(1)
    expect(t.removes).toBe(1)
  })

  it('nested body change inside matched parent → {updates: 1}', () => {
    const v1 = buildCandidateTree(
      <Toggle title="outer">
        <Paragraph>v1</Paragraph>
      </Toggle>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    const v2 = buildCandidateTree(
      <Toggle title="outer">
        <Paragraph>v2</Paragraph>
      </Toggle>,
      ROOT,
    )
    const ops = diff(cache, v2)
    expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
  })

  it('keyless fallback still passes by position', () => {
    const v1 = buildCandidateTree(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
      ROOT,
    )
    const cache = fakeApply(v1, diff(empty(), v1))
    // Same content, no keys → positional match keeps everything.
    const v2 = buildCandidateTree(
      <>
        <Paragraph>a</Paragraph>
        <Paragraph>b</Paragraph>
      </>,
      ROOT,
    )
    const ops = diff(cache, v2)
    expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 0 })
  })

  describe('sibling blockKey collision (C1)', () => {
    it('throws when candidate has duplicate sibling blockKeys', () => {
      const candidate = buildCandidateTree(
        <>
          {h('paragraph', kb('dup'), 'one')}
          {h('paragraph', kb('dup'), 'two')}
        </>,
        ROOT,
      )
      expect(() => diff(empty(), candidate)).toThrow(
        /duplicate blockKey 'k:dup' among siblings under parent .* — blockKey must be unique among siblings/,
      )
    })

    it('throws when cache has duplicate sibling blockKeys', () => {
      const cache: CacheTree = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        rootId: ROOT,
        children: [
          { key: 'k:dup', blockId: 'blk-1', type: 'paragraph', hash: 'h1', children: [] },
          { key: 'k:dup', blockId: 'blk-2', type: 'paragraph', hash: 'h2', children: [] },
        ],
      }
      const candidate = buildCandidateTree(<>{h('paragraph', kb('dup'), 'x')}</>, ROOT)
      expect(() => diff(cache, candidate)).toThrow(/duplicate blockKey 'k:dup'/)
    })
  })

  describe('same-key type change (C2)', () => {
    it('emits remove + insert (NOT update) when a retained key changes block type', () => {
      const v1 = buildCandidateTree(<>{h('paragraph', kb('x'), 'v1')}</>, ROOT)
      const cache = fakeApply(v1, diff(empty(), v1))
      const priorBlockId = cache.children[0]!.blockId

      const v2 = buildCandidateTree(<>{h('heading_2', kb('x'), 'v1')}</>, ROOT)
      const ops = diff(cache, v2)

      // No `update` — Notion rejects type changes via update.
      expect(ops.find((o) => o.kind === 'update')).toBeUndefined()
      // The old paragraph block is removed.
      expect(ops.find((o) => o.kind === 'remove' && o.blockId === priorBlockId)).toBeDefined()
      // A new heading block is appended (no later retained sibling).
      const newBlock = ops.find(
        (o) => (o.kind === 'append' || o.kind === 'insert') && o.type === 'heading_2',
      )
      expect(newBlock).toBeDefined()
    })
  })

  describe('prop-only updates', () => {
    // Changing a non-text prop on a block with a stable blockKey should diff
    // to exactly one `update` op — no remove+insert. This validates that
    // `blockProps` contributes the prop into the hash so the diff notices
    // the change without the key treatment being perturbed.
    //
    // None of the ergonomic block components expose `blockKey` directly
    // (it's a renderer-level identity hint), so we drop to the `h()` helper
    // and pass `blockKey` alongside the block's own props.
    it('callout color change → {updates: 1}', () => {
      const v1 = buildCandidateTree(h('callout', { blockKey: 'c', color: 'red' }, 'x'), ROOT)
      const cache = fakeApply(v1, diff(empty(), v1))
      const v2 = buildCandidateTree(h('callout', { blockKey: 'c', color: 'blue' }, 'x'), ROOT)
      const ops = diff(cache, v2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })

    it('to_do checked toggle → {updates: 1}', () => {
      const v1 = buildCandidateTree(h('to_do', { blockKey: 't', checked: false }, 'x'), ROOT)
      const cache = fakeApply(v1, diff(empty(), v1))
      const v2 = buildCandidateTree(h('to_do', { blockKey: 't', checked: true }, 'x'), ROOT)
      const ops = diff(cache, v2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })

    it('code language change → {updates: 1}', () => {
      const v1 = buildCandidateTree(h('code', { blockKey: 'k', language: 'typescript' }, 'x'), ROOT)
      const cache = fakeApply(v1, diff(empty(), v1))
      const v2 = buildCandidateTree(h('code', { blockKey: 'k', language: 'python' }, 'x'), ROOT)
      const ops = diff(cache, v2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })

    // NOTE: `caption` is not a first-class prop on media components and is
    // not projected by `blockProps` (see host-config.ts). The closest
    // diffable non-text prop on media blocks is `url`, which IS projected
    // into the hash via the `{type:'external', external:{url}}` envelope.
    // We pin behaviour on `url` change here — if/when a proper `caption`
    // projection lands, a dedicated case should be added.
    it('image url change → {updates: 1}', () => {
      const v1 = buildCandidateTree(
        h('image', { blockKey: 'i', url: 'https://example.com/a.png' }),
        ROOT,
      )
      const cache = fakeApply(v1, diff(empty(), v1))
      const v2 = buildCandidateTree(
        h('image', { blockKey: 'i', url: 'https://example.com/b.png' }),
        ROOT,
      )
      const ops = diff(cache, v2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })
  })

  describe('derisk-report 6-scenario table', () => {
    // Mirrors /tmp/pixeltrail-react-derisk/index.tsx verbatim. The report's
    // "ops" column counts total ops; we split into appends/updates/inserts/
    // removes.
    type Session = { id: string; title: string; body: string }

    const DailyPage = ({
      screenTime,
      apps,
      sessions,
    }: {
      screenTime: string
      apps: number
      sessions: Session[]
    }) => (
      <>
        <Heading2>Stats</Heading2>
        <Paragraph>{`${screenTime} · ${apps} apps`}</Paragraph>
        {h('divider', null)}
        <Heading2>Timeline</Heading2>
        {sessions.map((s) =>
          h('toggle', { blockKey: s.id, title: s.title }, <Paragraph>{s.body}</Paragraph>),
        )}
      </>
    )

    const v1: Session[] = [
      { id: 's1', title: '09:00 Terminal', body: '30 min focused' },
      { id: 's2', title: '10:00 Browser', body: 'research' },
      { id: 's3', title: '11:00 VSCode', body: 'coding session' },
    ]

    const render = (el: React.ReactNode) => buildCandidateTree(el, ROOT)

    it('initial render (3 sessions) → 10 appends total', () => {
      const cand = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const ops = diff(empty(), cand)
      const t = tallyDiff(ops)
      // 4 top-level (h2, p, divider, h2) + 3 toggles + 3 nested paragraphs = 10.
      expect(t.appends + t.inserts).toBe(10)
      expect(t.updates + t.removes).toBe(0)
    })

    it('one toggle body changed → {updates: 1}', () => {
      const cand1 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const cache = fakeApply(cand1, diff(empty(), cand1))
      const v2: Session[] = [
        { id: 's1', title: '09:00 Terminal', body: '45 min focused' },
        v1[1]!,
        v1[2]!,
      ]
      const cand2 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />)
      const ops = diff(cache, cand2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })

    it('session appended → 2 new-block ops', () => {
      const cand1 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const cache = fakeApply(cand1, diff(empty(), cand1))
      const v2: Session[] = [...v1, { id: 's4', title: '12:00 Slack', body: 'chat' }]
      const cand2 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />)
      const ops = diff(cache, cand2)
      const t = tallyDiff(ops)
      // toggle + nested paragraph = 2 new ops.
      expect(t.appends + t.inserts).toBe(2)
      expect(t.updates + t.removes).toBe(0)
    })

    it('session inserted mid → 2 new-block ops', () => {
      const cand1 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const cache = fakeApply(cand1, diff(empty(), cand1))
      const v2: Session[] = [
        v1[0]!,
        v1[1]!,
        { id: 's2b', title: '10:30 Figma', body: 'design' },
        v1[2]!,
      ]
      const cand2 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />)
      const ops = diff(cache, cand2)
      const t = tallyDiff(ops)
      expect(t.appends + t.inserts).toBe(2)
      expect(t.updates + t.removes).toBe(0)
    })

    it('stats text changed → {updates: 1}', () => {
      const cand1 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const cache = fakeApply(cand1, diff(empty(), cand1))
      const cand2 = render(<DailyPage screenTime="4h 30m" apps={7} sessions={v1} />)
      const ops = diff(cache, cand2)
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 1, inserts: 0, removes: 0 })
    })

    it('delete session → {removes: 1}', () => {
      const cand1 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v1} />)
      const cache = fakeApply(cand1, diff(empty(), cand1))
      const v2: Session[] = v1.filter((s) => s.id !== 's2')
      const cand2 = render(<DailyPage screenTime="4h 12m" apps={7} sessions={v2} />)
      const ops = diff(cache, cand2)
      // Removing the parent toggle is a single remove; Notion cascades the
      // child paragraph with its parent.
      expect(tallyDiff(ops)).toEqual({ appends: 0, updates: 0, inserts: 0, removes: 1 })
    })
  })
})
