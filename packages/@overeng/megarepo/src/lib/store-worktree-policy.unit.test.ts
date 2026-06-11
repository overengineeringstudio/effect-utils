import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import type { StoreLiveSet } from './store-liveness.ts'
import { classifyStoreWorktreePolicy, isNamedRefWorktree } from './store-worktree-policy.ts'

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
