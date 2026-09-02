import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  decodePrListJson,
  makeStubPrStateResolver,
  parseRepoCoordinates,
  PR_STATE_NONE,
  PrStateResolver,
  makeStubPrStateResolverLayer,
  resolvePrStateForBranch,
  type GhPr,
} from './store-pr-state.ts'

const rel = (p: string) => EffectPath.unsafe.relativeDir(p)

/** Compact PR-row builder; `gh` emits ISO timestamps or null. */
const pr = (partial: Partial<GhPr> & Pick<GhPr, 'number' | 'state' | 'headRefName'>): GhPr => ({
  mergedAt: null,
  closedAt: null,
  ...partial,
})

describe('store-pr-state', () => {
  describe('parseRepoCoordinates', () => {
    it('parses owner/repo from a github.com store path', () => {
      expect(parseRepoCoordinates(rel('github.com/overengineeringstudio/effect-utils/'))).toEqual(
        Option.some({ owner: 'overengineeringstudio', repo: 'effect-utils' }),
      )
    })

    it('bails on a non-github host (⇒ none, keep)', () => {
      expect(parseRepoCoordinates(rel('gitlab.com/owner/repo/'))).toEqual(Option.none())
    })

    it('bails on a local store path with no host/owner/repo triple', () => {
      expect(parseRepoCoordinates(rel('local/my-repo/'))).toEqual(Option.none())
    })
  })

  describe('decodePrListJson', () => {
    it('decodes a valid gh pr list payload', () => {
      const raw = JSON.stringify([
        {
          number: 1,
          state: 'MERGED',
          headRefName: 'feat/x',
          mergedAt: '2026-01-01T00:00:00Z',
          closedAt: null,
        },
      ])
      const decoded = decodePrListJson(raw)
      expect(Option.isSome(decoded)).toBe(true)
      expect(Option.getOrThrow(decoded)[0]?.number).toBe(1)
    })

    it('returns none for non-JSON output (gh error / non-zero exit)', () => {
      expect(decodePrListJson('error: not authenticated')).toEqual(Option.none())
    })

    it('returns none for JSON that violates the schema', () => {
      expect(decodePrListJson(JSON.stringify([{ number: 'nope' }]))).toEqual(Option.none())
    })
  })

  describe('resolvePrStateForBranch', () => {
    it('no matching PR ⇒ none (keep)', () => {
      const prs = [pr({ number: 1, state: 'MERGED', headRefName: 'other' })]
      expect(resolvePrStateForBranch({ prs, branch: 'feat/x' })).toEqual(PR_STATE_NONE)
    })

    it('joins by headRefName VERBATIM, including slashes in branch names', () => {
      const prs = [
        pr({ number: 1, state: 'MERGED', headRefName: 'feat/x', mergedAt: '2026-01-01T00:00:00Z' }),
        pr({
          number: 2,
          state: 'MERGED',
          headRefName: 'feat/x/nested',
          mergedAt: '2026-02-01T00:00:00Z',
        }),
      ]
      // 'feat/x' must NOT match 'feat/x/nested' (verbatim, not prefix).
      expect(resolvePrStateForBranch({ prs, branch: 'feat/x' })).toEqual({
        state: 'merged',
        mergedAt: Date.parse('2026-01-01T00:00:00Z'),
      })
      expect(resolvePrStateForBranch({ prs, branch: 'feat/x/nested' })).toEqual({
        state: 'merged',
        mergedAt: Date.parse('2026-02-01T00:00:00Z'),
      })
    })

    it('merged PR carries mergedAt in epoch ms', () => {
      const prs = [
        pr({ number: 7, state: 'MERGED', headRefName: 'b', mergedAt: '2026-03-04T05:06:07Z' }),
      ]
      expect(resolvePrStateForBranch({ prs, branch: 'b' })).toEqual({
        state: 'merged',
        mergedAt: Date.parse('2026-03-04T05:06:07Z'),
      })
    })

    it('closed PR carries closedAt and gets no post-close grace signal (state=closed)', () => {
      const prs = [
        pr({ number: 8, state: 'CLOSED', headRefName: 'b', closedAt: '2026-03-04T05:06:07Z' }),
      ]
      expect(resolvePrStateForBranch({ prs, branch: 'b' })).toEqual({
        state: 'closed',
        closedAt: Date.parse('2026-03-04T05:06:07Z'),
      })
    })

    it('multi-PR: ANY open ⇒ open even if a merged PR shares the branch', () => {
      const prs = [
        pr({ number: 1, state: 'MERGED', headRefName: 'b', mergedAt: '2026-01-01T00:00:00Z' }),
        pr({ number: 2, state: 'OPEN', headRefName: 'b' }),
      ]
      expect(resolvePrStateForBranch({ prs, branch: 'b' })).toEqual({ state: 'open' })
    })

    it('multi-PR (no open): most-recent merged/closed wins by its own timestamp', () => {
      const prs = [
        pr({ number: 1, state: 'CLOSED', headRefName: 'b', closedAt: '2026-01-01T00:00:00Z' }),
        pr({ number: 2, state: 'MERGED', headRefName: 'b', mergedAt: '2026-05-01T00:00:00Z' }),
        pr({ number: 3, state: 'CLOSED', headRefName: 'b', closedAt: '2026-03-01T00:00:00Z' }),
      ]
      expect(resolvePrStateForBranch({ prs, branch: 'b' })).toEqual({
        state: 'merged',
        mergedAt: Date.parse('2026-05-01T00:00:00Z'),
      })
    })

    it('multi-PR (no open): an older merged loses to a newer closed', () => {
      const prs = [
        pr({ number: 1, state: 'MERGED', headRefName: 'b', mergedAt: '2026-01-01T00:00:00Z' }),
        pr({ number: 2, state: 'CLOSED', headRefName: 'b', closedAt: '2026-09-01T00:00:00Z' }),
      ]
      expect(resolvePrStateForBranch({ prs, branch: 'b' })).toEqual({
        state: 'closed',
        closedAt: Date.parse('2026-09-01T00:00:00Z'),
      })
    })
  })

  describe('stub PrStateResolver layer', () => {
    const repos = [
      {
        relativePath: rel('github.com/overengineeringstudio/effect-utils/'),
        prs: [
          pr({
            number: 1,
            state: 'MERGED',
            headRefName: 'feat/x',
            mergedAt: '2026-01-01T00:00:00Z',
          }),
        ],
      },
    ]

    it('resolves a known branch through the service interface', () =>
      Effect.gen(function* () {
        const resolver = yield* PrStateResolver
        const result = yield* resolver.resolve({
          relativePath: rel('github.com/overengineeringstudio/effect-utils/'),
          branch: 'feat/x',
        })
        expect(result).toEqual({ state: 'merged', mergedAt: Date.parse('2026-01-01T00:00:00Z') })
      }).pipe(Effect.provide(makeStubPrStateResolverLayer(repos)), Effect.runPromise))

    it('unknown repo path ⇒ none (keep)', () => {
      const resolver = makeStubPrStateResolver(repos)
      return Effect.gen(function* () {
        const result = yield* resolver.resolve({
          relativePath: rel('github.com/overengineeringstudio/other/'),
          branch: 'feat/x',
        })
        expect(result).toEqual(PR_STATE_NONE)
      }).pipe(Effect.runPromise)
    })

    it('known repo but unmatched branch ⇒ none (keep)', () => {
      const resolver = makeStubPrStateResolver(repos)
      return Effect.gen(function* () {
        const result = yield* resolver.resolve({
          relativePath: rel('github.com/overengineeringstudio/effect-utils/'),
          branch: 'feat/missing',
        })
        expect(result).toEqual(PR_STATE_NONE)
      }).pipe(Effect.runPromise)
    })
  })
})
