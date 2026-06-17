import { describe, expect, it } from 'vitest'

import {
  gateNmdLocalState,
  NmdStatelessnessError,
  type NmdFrontmatterV2,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

import { canonicalize, semanticEqual } from './canonicalizer.ts'
import { decideReconcile, type ReconcileCompare } from './reconcile-core.ts'

/*
 * Adversarial footgun pass (R30). Each historically-observed footgun gets a
 * test that ATTEMPTS to trigger it and asserts it is now structurally
 * impossible. This is a release gate: the pass must score zero triggerable
 * footguns.
 */

const pageId = '00000000-0000-4000-8000-000000000001'

const frontmatter = (source: NmdFrontmatterV2['notion_md']['source']): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source,
    page_id: pageId,
    parent: { _tag: 'page', id: '00000000-0000-4000-8000-000000000000' },
    page: { title: 'T', icon: null, cover: null, in_trash: false, is_locked: false },
    properties: {},
  },
})

const syncState: NmdSyncStateV1 = {
  version: 1,
  page_id: pageId,
  body: {
    format: 'notion-enhanced-markdown',
    hash: `sha256:${'a'.repeat(64)}`,
    base: {
      _tag: 'object_ref',
      role: 'base_snapshot',
      hash: `sha256:${'a'.repeat(64)}`,
      path: '.notion-md/objects/sha256/aa/aaa.json',
      media_type: 'application/json',
      byte_length: 1,
    },
    last_pulled_at: '2026-05-22T14:50:00.000Z',
    remote_last_edited_time: '2026-05-22T14:49:59.000Z',
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
}

const cmp = (a: string, b: string): ReconcileCompare => ({ renderedLocal: a, currentRemote: b })

describe('FOOTGUN — stale-stored-base poisoned-noop (must be unreachable)', () => {
  it('a stored base on source: local is a schema violation, not a recoverable in-sync', () => {
    const gated = gateNmdLocalState({ frontmatter: frontmatter('local'), syncState })
    expect(gated).toBeInstanceOf(NmdStatelessnessError)
  })

  it('a stored base on source: remote is a schema violation', () => {
    const gated = gateNmdLocalState({ frontmatter: frontmatter('remote'), syncState })
    expect(gated).toBeInstanceOf(NmdStatelessnessError)
  })

  it('single-source gated states carry no syncState field (no base to drift stale)', () => {
    const local = gateNmdLocalState({ frontmatter: frontmatter('local'), syncState: undefined })
    const remote = gateNmdLocalState({ frontmatter: frontmatter('remote'), syncState: undefined })
    // structural: the only branch with `syncState` is shared-bound
    expect('syncState' in (local as object)).toBe(false)
    expect('syncState' in (remote as object)).toBe(false)
    const shared = gateNmdLocalState({ frontmatter: frontmatter('shared'), syncState })
    expect('syncState' in (shared as object)).toBe(true)
  })

  it('the single-source in-sync decision is a live compare, never a stored base', () => {
    // identical live bodies ⇒ noop regardless of any (absent) stored state
    const local = gateNmdLocalState({ frontmatter: frontmatter('local'), syncState: undefined })
    if (local instanceof NmdStatelessnessError) throw new Error('unexpected gate failure')
    expect(decideReconcile({ local, compare: cmp('x', 'x') })).toEqual({ _tag: 'noop' })
  })
})

describe('FOOTGUN — cosmetic perpetual churn #756 (must reach noop)', () => {
  const cosmeticVariants: ReadonlyArray<readonly [string, string]> = [
    ['*emphasis*', '_emphasis_'],
    ['__bold__', '**bold**'],
    ['2. a\n3. b', '1. a\n2. b'],
    ['- a\n\n- b', '- a\n- b'],
    ['trailing space   \njoined', 'trailing space\njoined'],
  ]

  it.each(cosmeticVariants)(
    'a semantically-equal hand-authored page reaches noop: %s ≡ %s',
    (authored, notionStored) => {
      const local = gateNmdLocalState({ frontmatter: frontmatter('local'), syncState: undefined })
      if (local instanceof NmdStatelessnessError) throw new Error('unexpected gate failure')
      expect(semanticEqual({ a: authored, b: notionStored })).toBe(true)
      expect(decideReconcile({ local, compare: cmp(authored, notionStored) })).toEqual({
        _tag: 'noop',
      })
    },
  )
})

describe('FOOTGUN — fidelity corruption #763/#759 (shapes must round-trip distinct)', () => {
  const shapePairs: ReadonlyArray<readonly [string, string, string]> = [
    ['#763 heading vs paragraph', '# Heading\n\ntext', 'Heading\n\ntext'],
    ['#763 heading level', '# H', '## H'],
    ['#759 divider present vs absent', 'a\n\n---\n\nb', 'a\n\nb'],
    ['#756 paragraph-after-list vs item', '- a\n\nparagraph', '- a\n- paragraph'],
  ]

  it.each(shapePairs)('%s stays distinct (not folded)', (_label, a, b) => {
    expect(canonicalize(a)).not.toBe(canonicalize(b))
    expect(semanticEqual({ a, b })).toBe(false)
  })
})

describe('FOOTGUN — wrong-direction push (must be structurally impossible)', () => {
  it('source: remote has no push branch — a changed remote pulls, never pushes', () => {
    const remote = gateNmdLocalState({ frontmatter: frontmatter('remote'), syncState: undefined })
    if (remote instanceof NmdStatelessnessError) throw new Error('unexpected gate failure')
    // remote differs from local: the only direction is pull (local is never pushed)
    expect(decideReconcile({ local: remote, compare: cmp('local edit', 'remote') })).toEqual({
      _tag: 'pull',
    })
  })

  it('source: remote|shared with no page_id is a decode-time error (cannot reach the engine)', () => {
    // enforced at the frontmatter schema; gate also defends in depth
    const badRemote = gateNmdLocalState({
      frontmatter: {
        notion_md: { ...frontmatter('remote').notion_md, page_id: null },
      },
      syncState: undefined,
    })
    expect(badRemote).toBeInstanceOf(NmdStatelessnessError)
  })
})
