import { describe, it } from '@effect/vitest'
import * as fc from 'effect/FastCheck'
import { expect } from 'vitest'

import type { StoreGcConfig } from './store-gc-config.ts'
import type { StoreLiveSet } from './store-liveness.ts'
import type { PrStateInfo } from './store-pr-state.ts'
import {
  classifyColdWorktree,
  classifyStoreWorktreePolicy,
  isNamedRefWorktree,
  type ColdWorktreeDecision,
  type StoreWorktreeLossless,
  type StoreWorktreePolicyTarget,
} from './store-worktree-policy.ts'

const liveSet = (paths: ReadonlyArray<string>): StoreLiveSet => ({
  paths: new Set(paths),
  workspaceCount: 1,
  uncleanReconcilePaths: new Set(),
})

describe('store-worktree-policy', () => {
  it('keeps branch and tag worktrees by default', () => {
    expect(
      classifyStoreWorktreePolicy({
        liveSet: liveSet([]),
        mode: 'default',
        worktree: { refType: 'heads', path: '/store/repo/refs/heads/main' },
      }),
    ).toEqual({
      isProtected: true,
      message: 'named branch ref',
      reason: 'named_branch_ref',
    })

    expect(
      classifyStoreWorktreePolicy({
        liveSet: liveSet([]),
        mode: 'default',
        worktree: { refType: 'tags', path: '/store/repo/refs/tags/v1.0.0' },
      }),
    ).toEqual({
      isProtected: true,
      message: 'named tag ref',
      reason: 'named_tag_ref',
    })
  })

  it('keeps root-set commit worktrees by default', () => {
    const path = '/store/repo/refs/commits/abc'

    expect(
      classifyStoreWorktreePolicy({
        liveSet: liveSet([path]),
        mode: 'default',
        worktree: { refType: 'commits', path },
      }),
    ).toEqual({
      isProtected: true,
      message: 'referenced by workspace root set',
      reason: 'workspace_root_set',
    })
  })

  it('makes unrooted commit worktrees eligible by default', () => {
    expect(
      classifyStoreWorktreePolicy({
        liveSet: liveSet([]),
        mode: 'default',
        worktree: { refType: 'commits', path: '/store/repo/refs/commits/abc' },
      }),
    ).toEqual({
      isProtected: false,
      message: undefined,
      reason: undefined,
    })
  })

  it('does not protect any ref kind in all mode', () => {
    const set = liveSet(['/store/repo/refs/commits/abc'])

    for (const refType of ['heads', 'tags', 'commits'] as const) {
      expect(
        classifyStoreWorktreePolicy({
          liveSet: set,
          mode: 'all',
          worktree: { refType, path: '/store/repo/refs/commits/abc' },
        }),
      ).toEqual({
        isProtected: false,
        message: undefined,
        reason: undefined,
      })
    }
  })

  it('identifies named refs', () => {
    expect(isNamedRefWorktree({ refType: 'heads', path: '/heads/main' })).toBe(true)
    expect(isNamedRefWorktree({ refType: 'tags', path: '/tags/v1' })).toBe(true)
    expect(isNamedRefWorktree({ refType: 'commits', path: '/commits/abc' })).toBe(false)
  })
})

// =============================================================================
// classifyColdWorktree
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_000_000 * DAY_MS

const COLD_PATH = '/store/repo/refs/heads/feature'

const config: StoreGcConfig = {
  absenceGraceMs: 14 * DAY_MS,
  postMergeGraceMs: 7 * DAY_MS,
  archiveRetentionMs: 30 * DAY_MS,
}

const target: StoreWorktreePolicyTarget = { refType: 'heads', path: COLD_PATH }

const recoverable: StoreWorktreeLossless = { unpushed: 0, dirty: false, hasStash: false }

/** Cold long enough that absence grace is satisfied (gate 4 passes). */
const coldLongAgo = NOW - 30 * DAY_MS

/** Merged far enough in the past that post-merge grace is satisfied (gate 5 passes). */
const mergedLongAgo: PrStateInfo = { state: 'merged', mergedAt: NOW - 30 * DAY_MS }

const classify = (overrides: {
  worktree?: StoreWorktreePolicyTarget
  liveSet?: StoreLiveSet
  prState: PrStateInfo
  lossless?: StoreWorktreeLossless
  coldSinceMs?: number | undefined
  now?: number
}): ColdWorktreeDecision =>
  classifyColdWorktree({
    worktree: overrides.worktree ?? target,
    liveSet: overrides.liveSet ?? liveSet([]),
    prState: overrides.prState,
    lossless: overrides.lossless ?? recoverable,
    coldSinceMs: 'coldSinceMs' in overrides ? overrides.coldSinceMs : coldLongAgo,
    config,
    now: overrides.now ?? NOW,
  })

describe('classifyColdWorktree gate precedence', () => {
  /**
   * Each row is set up so the named gate is the FIRST that fires: all earlier
   * gates pass, proving the gate's short-circuit precedence over later signals.
   */
  it('gate 1: in live set ⇒ keep(live) even when merged+reachable+grace-met', () => {
    // Later gates would archive, but liveness vetoes first.
    expect(
      classify({ liveSet: liveSet([COLD_PATH]), prState: mergedLongAgo }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'live' })
  })

  it('gate 2: prState open ⇒ keep(not-stale)', () => {
    expect(classify({ prState: { state: 'open' } })).toEqual<ColdWorktreeDecision>({
      _tag: 'keep',
      reason: 'not-stale',
    })
  })

  it('gate 2: prState none ⇒ keep(not-stale) even when long cold', () => {
    expect(classify({ prState: { state: 'none' } })).toEqual<ColdWorktreeDecision>({
      _tag: 'keep',
      reason: 'not-stale',
    })
  })

  it('gate 3: unpushed>0 ⇒ keep(unrecoverable-local-work) over merged+grace-met', () => {
    expect(
      classify({
        prState: mergedLongAgo,
        lossless: { unpushed: 1, dirty: false, hasStash: false },
      }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'unrecoverable-local-work' })
  })

  it('gate 3: hasStash ⇒ keep(unrecoverable-local-work) over merged+grace-met', () => {
    expect(
      classify({ prState: mergedLongAgo, lossless: { unpushed: 0, dirty: false, hasStash: true } }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'unrecoverable-local-work' })
  })

  it('gate 4: coldSince undefined ⇒ keep(absence-grace) (re-arm)', () => {
    expect(
      classify({ prState: mergedLongAgo, coldSinceMs: undefined }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'absence-grace' })
  })

  it('gate 4: absence grace not yet elapsed ⇒ keep(absence-grace)', () => {
    expect(
      classify({ prState: mergedLongAgo, coldSinceMs: NOW - (14 * DAY_MS - 1) }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'absence-grace' })
  })

  it('gate 5: merged missing mergedAt ⇒ keep(defensive)', () => {
    expect(classify({ prState: { state: 'merged' } })).toEqual<ColdWorktreeDecision>({
      _tag: 'keep',
      reason: 'defensive',
    })
  })

  it('gate 5: merged within post-merge grace ⇒ keep(post-merge-grace)', () => {
    expect(
      classify({ prState: { state: 'merged', mergedAt: NOW - (7 * DAY_MS - 1) } }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'post-merge-grace' })
  })

  it('gate 6: merged + all gates passed ⇒ archive(merged)', () => {
    expect(classify({ prState: mergedLongAgo })).toEqual<ColdWorktreeDecision>({
      _tag: 'archive',
      reason: 'merged',
    })
  })

  it('gate 6: closed has no post-close grace ⇒ archive(closed)', () => {
    // Closed just now (no grace), absence grace met, recoverable ⇒ archive.
    expect(classify({ prState: { state: 'closed', closedAt: NOW } })).toEqual<ColdWorktreeDecision>(
      { _tag: 'archive', reason: 'closed' },
    )
  })
})

describe('classifyColdWorktree near-misses', () => {
  it('merged + grace met + not reachable (unpushed>0) ⇒ keep', () => {
    expect(
      classify({
        prState: mergedLongAgo,
        lossless: { unpushed: 3, dirty: false, hasStash: false },
      }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'unrecoverable-local-work' })
  })

  it('merged + grace met + reachable + dirty ⇒ archive (dirt moves with the dir)', () => {
    expect(
      classify({ prState: mergedLongAgo, lossless: { unpushed: 0, dirty: true, hasStash: false } }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'archive', reason: 'merged' })
  })

  it('closed + reachable + absence grace met ⇒ archive(closed)', () => {
    expect(
      classify({ prState: { state: 'closed', closedAt: NOW - 5 * DAY_MS } }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'archive', reason: 'closed' })
  })

  it('absence grace met but post-merge grace unmet ⇒ keep(post-merge-grace)', () => {
    expect(
      classify({
        prState: { state: 'merged', mergedAt: NOW - 1 * DAY_MS },
        coldSinceMs: NOW - 20 * DAY_MS,
      }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'post-merge-grace' })
  })

  it('absence grace exactly at boundary (now-coldSince === absenceGrace) ⇒ proceeds', () => {
    // Strict `<` means equality is NOT within grace; gate 4 passes, gate 6 archives.
    expect(
      classify({ prState: mergedLongAgo, coldSinceMs: NOW - 14 * DAY_MS }),
    ).toEqual<ColdWorktreeDecision>({ _tag: 'archive', reason: 'merged' })
  })
})

// =============================================================================
// Property-based invariants (decisions 0001–0009, invariants 1–3)
// =============================================================================

const arbPrState: fc.Arbitrary<PrStateInfo> = fc.oneof(
  fc.constant<PrStateInfo>({ state: 'open' }),
  fc.constant<PrStateInfo>({ state: 'none' }),
  fc
    .option(fc.integer({ min: 0, max: NOW }), { nil: undefined })
    .map((mergedAt): PrStateInfo => ({ state: 'merged', mergedAt })),
  fc
    .option(fc.integer({ min: 0, max: NOW }), { nil: undefined })
    .map((closedAt): PrStateInfo => ({ state: 'closed', closedAt })),
)

const arbLossless: fc.Arbitrary<StoreWorktreeLossless> = fc.record({
  unpushed: fc.integer({ min: 0, max: 50 }),
  dirty: fc.boolean(),
  hasStash: fc.boolean(),
})

const arbColdSince: fc.Arbitrary<number | undefined> = fc.option(fc.integer({ min: 0, max: NOW }), {
  nil: undefined,
})

describe('classifyColdWorktree invariants (property)', () => {
  it.prop(
    'a worktree in the live set is NEVER archived (invariant 1)',
    [arbPrState, arbLossless, arbColdSince],
    ([prState, lossless, coldSinceMs]) => {
      const decision = classifyColdWorktree({
        worktree: target,
        liveSet: liveSet([COLD_PATH]),
        prState,
        lossless,
        coldSinceMs,
        config,
        now: NOW,
      })
      expect(decision).toEqual<ColdWorktreeDecision>({ _tag: 'keep', reason: 'live' })
    },
    { fastCheck: { numRuns: 200 } },
  )

  it.prop(
    'open or no-PR worktrees are always kept (decision 0005)',
    [fc.constantFrom<PrStateInfo>({ state: 'open' }, { state: 'none' }), arbLossless, arbColdSince],
    ([prState, lossless, coldSinceMs]) => {
      const decision = classifyColdWorktree({
        worktree: target,
        liveSet: liveSet([]),
        prState,
        lossless,
        coldSinceMs,
        config,
        now: NOW,
      })
      expect(decision._tag).toBe('keep')
    },
    { fastCheck: { numRuns: 200 } },
  )

  it.prop(
    'unpushed>0 always keeps (lossless floor, invariant 2)',
    [arbPrState, fc.integer({ min: 1, max: 50 }), fc.boolean(), fc.boolean(), arbColdSince],
    ([prState, unpushed, dirty, hasStash, coldSinceMs]) => {
      const decision = classifyColdWorktree({
        worktree: target,
        liveSet: liveSet([]),
        prState,
        lossless: { unpushed, dirty, hasStash },
        coldSinceMs,
        config,
        now: NOW,
      })
      expect(decision._tag).toBe('keep')
    },
    { fastCheck: { numRuns: 200 } },
  )

  it.prop(
    'hasStash always keeps (lossless floor, invariant 2)',
    [arbPrState, fc.integer({ min: 0, max: 50 }), fc.boolean(), arbColdSince],
    ([prState, unpushed, dirty, coldSinceMs]) => {
      const decision = classifyColdWorktree({
        worktree: target,
        liveSet: liveSet([]),
        prState,
        lossless: { unpushed, dirty, hasStash: true },
        coldSinceMs,
        config,
        now: NOW,
      })
      expect(decision._tag).toBe('keep')
    },
    { fastCheck: { numRuns: 200 } },
  )
})
