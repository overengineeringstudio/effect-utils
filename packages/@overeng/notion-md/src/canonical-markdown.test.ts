import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from '@effect/vitest'
import * as fc from 'effect/testing/FastCheck'

import { canonicalizeBlockMarkdown, semanticEquivalent } from './canonical-markdown.ts'
import { sha256Digest } from './hash.ts'

describe('canonicalizeBlockMarkdown re-export', () => {
  // The canonical function now lives in `@overeng/notion-effect-client` (its
  // own unit tests cover behavior); notion-md re-exports it. Smoke-test that
  // the re-export resolves and produces the canonical (tight-list) form.
  it('re-exports the canonical body function', () => {
    expect(canonicalizeBlockMarkdown('- a\n\n- b\n')).toBe('- a\n- b\n')
  })
})

describe('semanticEquivalent', () => {
  it('treats Notion-collapsed blank lines as equivalent to the sent form', () => {
    const sent = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'
    const returnedFromNotion = 'First paragraph.\nSecond paragraph.\nThird paragraph.\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(true)
  })

  it('ignores list-indent style differences (spaces vs tabs)', () => {
    const sent = '- item one\n  continued\n- item two\n'
    const returnedFromNotion = '- item one\n\tcontinued\n- item two\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(true)
  })

  it('flags real content drift', () => {
    const sent = 'Hello world.\n'
    const returnedFromNotion = 'Hello mars.\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(false)
  })

  it('flags reordered tokens as drift', () => {
    const sent = 'one two three\n'
    const returnedFromNotion = 'three two one\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(false)
  })

  it('flags whitespace-significant diffs inside fenced code blocks', () => {
    const sent = 'Intro.\n\n```ts\nconst x = 1\n  const y = 2\n```\n'
    const drifted = 'Intro.\n\n```ts\nconst x = 1\nconst y = 2\n```\n'
    expect(semanticEquivalent({ a: sent, b: drifted })).toBe(false)
  })

  it('accepts equivalent fenced code blocks verbatim', () => {
    const sent = 'Intro.\n\n```ts\nconst x = 1\nconst y = 2\n```\n'
    const same = 'Intro.\n```ts\nconst x = 1\nconst y = 2\n```\n'
    expect(semanticEquivalent({ a: sent, b: same })).toBe(true)
  })

  it('treats two rotated hosted-media signature variants as equivalent', () => {
    const host = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/photo.png'
    const params =
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260615T120000Z&X-Amz-Expires=3600'
    const pullOne = `![caption](${host}${params}&X-Amz-Signature=deadbeef)\n`
    const pullTwo = `![caption](${host}${params}&X-Amz-Signature=cafef00d)\n`
    expect(semanticEquivalent({ a: pullOne, b: pullTwo })).toBe(true)
  })

  it('still flags a real change to a hosted-media caption', () => {
    const host = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/photo.png'
    const a = `![before](${host}?X-Amz-Signature=deadbeef)\n`
    const b = `![after](${host}?X-Amz-Signature=cafef00d)\n`
    expect(semanticEquivalent({ a, b })).toBe(false)
  })
})

/*
 * Two-oracle agreement on canonical inputs (decision 0019).
 *
 * The system has two oracles for "did the body change":
 *   - the RAW-HASH oracle — `sha256Digest` over the body (`classifyPlan` in
 *     `tree.ts` compares `prevState.body.hash === sha256Digest(composed)`); a
 *     byte-exact digest, NOT canonicalization-invariant.
 *   - the CANON-INVARIANT oracle — `semanticEquivalent`, which canonicalizes
 *     both sides before comparing (the push integrity gate).
 *
 * Post-consolidation, decision 0019 routes BOTH wire boundaries through
 * `canonicalizeBlockMarkdown`, so every body the oracles ever see is already
 * canonical. For canonical inputs the two oracles MUST agree: raw-hash-equal
 * ⟺ semanticEquivalent-true. They may legitimately disagree only on
 * non-canonical inputs (where the raw hash sees spelling/spacing the canonical
 * compare folds away).
 *
 * The referee is NEITHER oracle: it is `canonicalize-then-byte-equal`. Asserting
 * each oracle against this independent judge is what guards the exact failure
 * mode a future canonicalization change could silently introduce — e.g. a change
 * that makes `semanticEquivalent` call two distinct canonical bodies equal would
 * surface as `semEq !== referee`, not hide behind the oracle it would corrupt.
 */
describe('two-oracle agreement on canonical inputs (decision 0019)', () => {
  /**
   * Assert both oracles match the referee for a pair of ALREADY-canonical
   * bodies (the now-guaranteed pull form). The premise — inputs are canonical —
   * is itself asserted (idempotence), so a regression that breaks canonical
   * fixpoint fails here too.
   */
  const assertOraclesAgree = (rawA: string, rawB: string): void => {
    const ca = canonicalizeBlockMarkdown(rawA)
    const cb = canonicalizeBlockMarkdown(rawB)
    // Premise: the canonical form is a fixpoint (already-canonical inputs).
    expect(canonicalizeBlockMarkdown(ca)).toBe(ca)
    expect(canonicalizeBlockMarkdown(cb)).toBe(cb)

    const referee = ca === cb
    const rawHashEqual = sha256Digest(ca) === sha256Digest(cb)
    const semanticEqual = semanticEquivalent({ a: ca, b: cb })

    expect(rawHashEqual).toBe(referee)
    expect(semanticEqual).toBe(referee)
  }

  // Seed pairs the system is known to (or could) diverge on: each pair is two
  // raw spellings of the SAME content that canonicalization must converge to
  // identical bytes (referee true → both oracles true), plus distinct-content
  // pairs (referee false → both oracles false). Random generation alone rarely
  // hits the convergent cases, so these seeds carry the discriminating power.
  const seedPairs: ReadonlyArray<{
    readonly name: string
    readonly a: string
    readonly b: string
  }> = [
    { name: 'emphasis fold (*x* vs _x_)', a: '*x*\n', b: '_x_\n' },
    { name: 'loose vs tight list', a: '- a\n\n- b\n', b: '- a\n- b\n' },
    { name: 'soft-wrapped vs unwrapped paragraph', a: 'one\ntwo\n', b: 'one two\n' },
    { name: 'bullet marker style (* vs -)', a: '* a\n* b\n', b: '- a\n- b\n' },
    { name: 'heading-to-text blank-line spacing', a: '# H\ntext\n', b: '# H\n\ntext\n' },
    { name: 'distinct content', a: 'apple\n', b: 'banana\n' },
    { name: 'distinct lists', a: '- a\n- b\n', b: '- a\n- c\n' },
  ]

  for (const seed of seedPairs) {
    it(`oracles agree with the referee for: ${seed.name}`, () => {
      assertOraclesAgree(seed.a, seed.b)
    })
  }

  // Property: for arbitrary bodies, canonicalizing both ALWAYS makes the two
  // oracles agree with the referee. Broadens the seeds; the seeds guarantee the
  // convergent (referee-true) branch is exercised, this covers the long tail.
  it.prop(
    'oracles agree with the referee for arbitrary canonical bodies',
    [fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 })],
    ([a, b]) => {
      assertOraclesAgree(a, b)
    },
    { fastCheck: { numRuns: 200 } },
  )

  // Premise standalone: canonicalization is idempotent (the pull form is a
  // fixpoint), so "already canonical" is a meaningful, achievable state.
  it.prop(
    'canonicalizeBlockMarkdown is idempotent',
    [fc.string({ maxLength: 160 })],
    ([raw]) => {
      const once = canonicalizeBlockMarkdown(raw)
      expect(canonicalizeBlockMarkdown(once)).toBe(once)
    },
    { fastCheck: { numRuns: 200 } },
  )
})

/*
 * Golden-file fixpoint over the durable demo (`demo/showcase.nmd`).
 *
 * The demo is the committed live showcase, re-baselined by the body/Markdown
 * consolidation (decision 0019). Its body must already be in canonical form —
 * a real `sync` would not rewrite it — and canonicalization must be idempotent
 * over it. This locks the re-baseline and catches future drift (a canon change
 * that would make the demo body non-canonical fails here).
 *
 * We extract the body via the raw frontmatter boundary (NOT `parseNmdFile`) so
 * the assertion targets exactly the body bytes, independent of frontmatter
 * schema version.
 */
describe('demo/showcase.nmd golden-file fixpoint (decision 0019)', () => {
  const demoPath = fileURLToPath(new URL('../demo/showcase.nmd', import.meta.url))

  /** Split the `.nmd` envelope at the closing `---` and return the raw body. */
  const demoBody = (): string => {
    const content = readFileSync(demoPath, 'utf8').replace(/\r\n/g, '\n')
    const marker = '\n---\n'
    const end = content.indexOf(marker, 4)
    expect(end).toBeGreaterThan(0)
    return content.slice(end + marker.length).replace(/^\n/u, '')
  }

  it('committed demo body is already canonical (sync would not rewrite it)', () => {
    const body = demoBody()
    expect(canonicalizeBlockMarkdown(body)).toBe(body)
  })

  it('canonicalization is idempotent over the demo body', () => {
    const canon = canonicalizeBlockMarkdown(demoBody())
    expect(canonicalizeBlockMarkdown(canon)).toBe(canon)
  })
})
