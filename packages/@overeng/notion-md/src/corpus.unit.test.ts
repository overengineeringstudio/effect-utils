import { describe, expect, it } from 'vitest'

import { canonicalizeBlockMarkdown } from './canonical-markdown.ts'
import { canonicalize, semanticEqual } from './canonicalizer.ts'
import { corpusEntry, fidelityCorpus } from './corpus.ts'

/*
 * Offline replay of the golden fidelity corpus (R35). This gates every run: a
 * regression in the R33 canonicalizer that re-breaks a #756/#759/#763 shape
 * fails here without needing live Notion. The corpus's `notion_round_trip`
 * values are captured from real Notion through the canonical body-observation
 * path; the replay logic is permanent.
 */

describe('fidelity corpus — offline replay (R35)', () => {
  it('has entries covering the historically-broken shapes', () => {
    const issues = new Set(fidelityCorpus.entries.map((entry) => entry.issue))
    expect(issues.has('#756')).toBe(true)
    expect(issues.has('#763')).toBe(true)
    expect(issues.has('#759')).toBe(true)
  })

  it('stores the canonical body form returned by live observations', () => {
    for (const entry of fidelityCorpus.entries) {
      expect(canonicalizeBlockMarkdown(entry.notion_round_trip).trim(), entry.id).toBe(
        entry.notion_round_trip,
      )
    }
  })

  it.each([
    ['para-after-list-756', '- alpha\n\n- beta\n\nA closing paragraph.'],
    ['para-after-list-as-item-756', '- alpha\n\n- beta\n\n- A closing paragraph.'],
    ['emphasis-marker-churn-756', 'a *word* and **bold** here'],
    ['ordered-list-renumber-756', '1. first\n\n1. second\n\n1. third'],
  ])(
    'canonicalizes the prior raw-rendered live capture without changing fidelity: %s',
    (id, raw) => {
      const entry = corpusEntry(id)
      expect(entry).toBeDefined()
      if (entry !== undefined) {
        expect(canonicalizeBlockMarkdown(raw).trim()).toBe(entry.notion_round_trip)
        expect(semanticEqual({ a: raw, b: entry.notion_round_trip })).toBe(true)
        expect(semanticEqual({ a: entry.authored, b: raw })).toBe(true)
      }
    },
  )

  const equalEntries = fidelityCorpus.entries.filter((entry) => entry.relation === 'equal')
  it.each(equalEntries.map((entry) => [entry.id, entry] as const))(
    'fidelity preserved: %s — authored ≡ Notion round-trip (reaches noop)',
    (_id, entry) => {
      expect(semanticEqual({ a: entry.authored, b: entry.notion_round_trip })).toBe(true)
    },
  )

  const distinctEntries = fidelityCorpus.entries.filter(
    (entry) => entry.relation === 'distinct_from',
  )
  it.each(distinctEntries.map((entry) => [entry.id, entry] as const))(
    'shape preserved: %s — canonical form stays DISTINCT from its sibling',
    (_id, entry) => {
      expect(entry.distinct_from).toBeDefined()
      const sibling =
        entry.distinct_from === undefined ? undefined : corpusEntry(entry.distinct_from)
      expect(sibling).toBeDefined()
      if (sibling !== undefined) {
        expect(canonicalize(entry.authored)).not.toBe(canonicalize(sibling.authored))
        // and the round-trips must also stay distinct (Notion preserved the shape)
        expect(canonicalize(entry.notion_round_trip)).not.toBe(
          canonicalize(sibling.notion_round_trip),
        )
      }
    },
  )

  it('every entry round-trips through its own canonical form idempotently', () => {
    for (const entry of fidelityCorpus.entries) {
      const once = canonicalize(entry.authored)
      expect(canonicalize(once)).toBe(once)
    }
  })
})
