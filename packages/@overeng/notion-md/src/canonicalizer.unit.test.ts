import { FastCheck as fc } from 'effect'
import { describe, expect, it } from 'vitest'

import { canonicalize, canonicalHash, semanticEqual } from './canonicalizer.ts'

/*
 * The R33 semantic-equivalence oracle. These tests are the proof obligation
 * for DQ-VNEXT-1: idempotency of the normal form, the equivalence-relation
 * laws, and — most importantly — that the #756-class COSMETIC variants compare
 * EQUAL while the #759/#763-class SEMANTIC shapes compare DISTINCT.
 */

/** #756-class: cosmetically different, semantically equal — must fold to EQUAL. */
const cosmeticPairs: ReadonlyArray<readonly [string, string, string]> = [
  ['emphasis * vs _', '*hello* world', '_hello_ world'],
  ['strong ** vs __', '**hello** world', '__hello__ world'],
  ['ordered-list start 2 vs 1', '2. a\n3. b\n4. c', '1. a\n2. b\n3. c'],
  ['ordered-list start 5 vs 1', '5. a\n6. b', '1. a\n2. b'],
  ['loose vs tight list', '- a\n\n- b\n\n- c', '- a\n- b\n- c'],
  ['table padding vs tight', '| a | bbbb |\n|:--|----:|\n| 1 | 2 |', '|a|bbbb|\n|:-|-:|\n|1|2|'],
  ['trailing whitespace', 'line one   \nline two', 'line one\nline two'],
  ['blank-line runs', 'a\n\n\n\nb', 'a\n\nb'],
  ['CRLF vs LF', 'a\r\n\r\nb', 'a\n\nb'],
  ['code-fence js alias', '```js\nconst x = 1\n```', '```javascript\nconst x = 1\n```'],
  ['code-fence ts alias', '```ts\nconst x = 1\n```', '```typescript\nconst x = 1\n```'],
]

/**
 * #759/#763-class: semantically different shapes — must stay DISTINCT.
 * Folding any of these is the historical fidelity-corruption footgun.
 */
const semanticPairs: ReadonlyArray<readonly [string, string, string]> = [
  ['heading level h1 vs h2 (#763)', '# Heading', '## Heading'],
  ['heading vs paragraph (#763)', '# Heading', 'Heading'],
  [
    'paragraph-after-list vs item (#756 shape stays distinct)',
    '- a\n\nparagraph',
    '- a\n- paragraph',
  ],
  ['divider present vs absent (#759)', 'a\n\n---\n\nb', 'a\n\nb'],
  ['code-fence language js vs ts', '```js\nx\n```', '```ts\nx\n```'],
  ['list item order', '- one\n- two', '- two\n- one'],
  ['ordered-list item order', '1. one\n2. two', '1. two\n2. one'],
  ['real content drift', 'Hello world.', 'Hello mars.'],
]

const samples = [
  '# Title\n\nSome *emphasis* and **strong** text.',
  '- a\n- b\n- c\n\nA trailing paragraph.',
  '1. first\n2. second',
  '```ts\nconst x = 1\n```',
  'a\n\n---\n\nb',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  'Plain paragraph that\nsoft-wraps across lines.',
]

describe('canonicalize — normal form', () => {
  it.each(samples)('is idempotent: canonicalize∘canonicalize == canonicalize (%#)', (sample) => {
    const once = canonicalize(sample)
    expect(canonicalize(once)).toBe(once)
  })

  it('is idempotent under property generation', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = canonicalize(s)
        return canonicalize(once) === once
      }),
      { numRuns: 200 },
    )
  })
})

describe('semanticEqual — equivalence relation laws', () => {
  it('is reflexive', () => {
    fc.assert(
      fc.property(fc.string(), (s) => semanticEqual({ a: s, b: s })),
      { numRuns: 200 },
    )
  })

  it('is symmetric', () => {
    const allPairs = [...cosmeticPairs, ...semanticPairs]
    for (const [, a, b] of allPairs) {
      expect(semanticEqual({ a, b })).toBe(semanticEqual({ a: b, b: a }))
    }
  })

  it('is transitive over cosmetic variants', () => {
    // a ~ b and b ~ c ⇒ a ~ c, witnessed across the cosmetic table.
    for (const [, a, b] of cosmeticPairs) {
      const c = canonicalize(b)
      expect(semanticEqual({ a, b }) && semanticEqual({ a: b, b: c })).toBe(true)
      expect(semanticEqual({ a, b: c })).toBe(true)
    }
  })
})

describe('R33 cosmetic folds (#756 class) — must compare EQUAL', () => {
  it.each(cosmeticPairs)('%s', (_label, a, b) => {
    expect(semanticEqual({ a, b })).toBe(true)
    expect(canonicalHash(a)).toBe(canonicalHash(b))
  })
})

describe('R33 semantic shapes (#759/#763 class) — must compare DISTINCT', () => {
  it.each(semanticPairs)('%s', (_label, a, b) => {
    expect(semanticEqual({ a, b })).toBe(false)
    expect(canonicalHash(a)).not.toBe(canonicalHash(b))
  })
})
