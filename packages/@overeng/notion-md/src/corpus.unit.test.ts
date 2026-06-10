import { describe, expect, it } from 'vitest'

import { canonicalize, semanticEqual } from './canonicalizer.ts'
import { corpusEntry, fidelityCorpus } from './corpus.ts'

/*
 * Offline replay of the golden fidelity corpus (R35). This gates every run: a
 * regression in the R33 canonicalizer that re-breaks a #756/#759/#763 shape
 * fails here without needing live Notion. The corpus's `notion_round_trip`
 * values are captured from real Notion (or, until a credentialed refresh,
 * authored from the documented normalizations); the replay logic is permanent.
 */

describe('fidelity corpus — offline replay (R35)', () => {
  it('has entries covering the historically-broken shapes', () => {
    const issues = new Set(fidelityCorpus.entries.map((entry) => entry.issue))
    expect(issues.has('#756')).toBe(true)
    expect(issues.has('#763')).toBe(true)
    expect(issues.has('#759')).toBe(true)
  })

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
