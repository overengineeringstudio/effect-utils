import { describe, expect, it } from 'vitest'

import { computePinnedDrift } from './member.ts'

const sha = (n: string) => `${n}`.padEnd(40, '0')

describe('computePinnedDrift', () => {
  const locked = { ref: 'v2.0.0', commit: sha('bbbb') }

  it('reports drift when a commit worktree names a different sha', () => {
    const drift = computePinnedDrift({
      symlinkRef: { ref: sha('aaaa'), type: 'commit' },
      lockedMember: locked,
    })

    expect(drift).toEqual({ materialized: 'aaaa0000', locked: 'bbbb0000' })
  })

  it('reports no drift when a commit worktree matches the lock', () => {
    expect(
      computePinnedDrift({
        symlinkRef: { ref: sha('bbbb'), type: 'commit' },
        lockedMember: locked,
      }),
    ).toBeUndefined()
  })

  it('reports drift when a tag worktree names a different tag', () => {
    const drift = computePinnedDrift({
      symlinkRef: { ref: 'v1.0.0', type: 'tag' },
      lockedMember: locked,
    })

    expect(drift).toEqual({ materialized: 'v1.0.0', locked: 'v2.0.0' })
  })

  it('reports no drift for a tag worktree matching the lock', () => {
    // A tag worktree is named by tag, not sha. Comparing it against `commit` would report
    // drift for every correctly-materialized tag.
    expect(
      computePinnedDrift({ symlinkRef: { ref: 'v2.0.0', type: 'tag' }, lockedMember: locked }),
    ).toBeUndefined()
  })

  it('never reports drift for a branch worktree', () => {
    // Co-development deliberately moves HEAD ahead of the lock.
    expect(
      computePinnedDrift({ symlinkRef: { ref: 'main', type: 'branch' }, lockedMember: locked }),
    ).toBeUndefined()
  })

  it('reports no drift when the member is absent or unlocked', () => {
    expect(computePinnedDrift({ symlinkRef: undefined, lockedMember: locked })).toBeUndefined()
    expect(
      computePinnedDrift({
        symlinkRef: { ref: sha('aaaa'), type: 'commit' },
        lockedMember: undefined,
      }),
    ).toBeUndefined()
  })
})
