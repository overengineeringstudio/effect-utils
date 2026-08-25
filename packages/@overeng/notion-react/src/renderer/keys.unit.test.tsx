import { describe, expect, it } from 'vitest'

import { Heading2, Paragraph, Toggle } from '../components/blocks.ts'
import { blockKey, NodeKey } from './keys.ts'
import { buildCandidateTree, candidateToCache, diff } from './sync-diff.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'

/**
 * Contract test for the `NodeKey` encoder: the keys it produces MUST be
 * byte-identical to the keys `buildCandidateTree` assigns, or any consumer
 * that addresses cache entries via the encoder (the whole point of exporting
 * it) diffs against phantom keys and rebuilds the page.
 */
describe('NodeKey encoder', () => {
  it('matches the keys buildCandidateTree assigns', () => {
    const tree = buildCandidateTree(
      <>
        <Heading2>unkeyed heading</Heading2>
        <Paragraph blockKey="intro">keyed paragraph</Paragraph>
        <Toggle blockKey={blockKey('s1')} title="business-keyed toggle">
          <Paragraph>nested unkeyed</Paragraph>
        </Toggle>
      </>,
      ROOT,
    )
    expect(tree.children.map((c) => c.key)).toEqual([
      NodeKey.positional(0),
      NodeKey.keyed('intro'),
      NodeKey.keyed(blockKey('s1')),
    ])
    // Nested siblings restart positional numbering per parent.
    expect(tree.children[2]!.children[0]!.key).toBe(NodeKey.positional(0))
    // The `b:` business namespace composes with the `k:` encoding.
    expect(tree.children[2]!.key).toBe('k:b:s1')
  })

  it('round-trips through the cache: encoder-addressed entries are retained by diff', () => {
    const element = (
      <>
        <Paragraph blockKey="a">alpha</Paragraph>
        <Paragraph>positional</Paragraph>
      </>
    )
    const candidate = buildCandidateTree(element, ROOT)
    // Materialize ids as a successful sync would, then snapshot the cache.
    const assign = (nodes: readonly (typeof candidate.children)[number][]): void => {
      for (const [i, n] of nodes.entries()) {
        n.blockId = `${n.key}-id-${i}`
        assign(n.children)
      }
    }
    assign(candidate.children)
    const cache = candidateToCache(candidate, 3)
    expect(cache.children.map((c) => c.key)).toEqual([NodeKey.keyed('a'), NodeKey.positional(1)])
    // A rebuilt candidate diffs to zero ops against the cache written with
    // encoder-shaped keys — key identity is stable across render → cache.
    expect(diff(cache, buildCandidateTree(element, ROOT))).toEqual([])
  })
})
