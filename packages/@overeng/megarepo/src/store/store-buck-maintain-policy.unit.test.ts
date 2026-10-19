import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  decideBuckOut,
  decideMaintainGate,
  isDaemonIdle,
  isInBlackout,
  matchesMaintainOwner,
  type MaintainSkipReason,
} from './store-buck-maintain-policy.ts'
import {
  canIgnoreActivityProcessClaim,
  type WorkspaceActivityProcess,
} from './store-workspace-activity.ts'

const now = Date.UTC(2026, 9, 19, 12)
const hour = 3_600_000
const budget = {
  sizeBytes: 101,
  lastActivityMs: now - 48 * hour,
  now,
  policy: { budgetBytes: 100, keepSince: '24h' },
  inactive: true,
}
const idle = {
  activeCommands: [],
  attachedClients: 0,
  lastActivityMs: now - hour,
  now,
  idleStopAfterMs: hour,
}
const gate = {
  blackout: false,
  gitLocked: false,
  liveHolder: false,
  activeClaim: false,
  owners: ['seat/a'],
  currentAgent: 'seat/a',
  maintainOwners: [],
  maintainUnowned: false,
  leaseHeld: false,
}

describe('Buck output policy', () => {
  it('trims only strictly above budget', () => {
    expect(decideBuckOut({ ...budget, sizeBytes: 99 })).toBe('within-budget')
    expect(decideBuckOut({ ...budget, sizeBytes: 100 })).toBe('within-budget')
    expect(decideBuckOut(budget)).toBe('clean-stale')
  })
  it('keeps full clean opt-in and independent of budget', () => {
    expect(decideBuckOut(budget)).toBe('clean-stale')
    expect(
      decideBuckOut({
        ...budget,
        sizeBytes: 0,
        policy: { ...budget.policy, fullCleanWhenInactiveFor: '48h' },
      }),
    ).toBe('full-clean')
  })
  it('requires complete inactivity and the full threshold for full cleaning', () => {
    const full = { ...budget, policy: { ...budget.policy, fullCleanWhenInactiveFor: '48h' } }
    expect(decideBuckOut({ ...full, inactive: false })).toBe('clean-stale')
    expect(decideBuckOut({ ...full, lastActivityMs: now - 48 * hour + 1 })).toBe('clean-stale')
    expect(decideBuckOut(full)).toBe('full-clean')
    expect(decideBuckOut({ ...full, lastActivityMs: undefined })).toBe('clean-stale')
    expect(decideBuckOut({ ...full, lastActivityMs: Number.NaN })).toBe('clean-stale')
    expect(decideBuckOut({ ...full, lastActivityMs: now + 1 })).toBe('clean-stale')
  })
})

describe('daemon idle policy', () => {
  it('includes the exact idle threshold', () => {
    expect(isDaemonIdle(idle)).toBe(true)
    expect(isDaemonIdle({ ...idle, lastActivityMs: idle.lastActivityMs + 1 })).toBe(false)
  })
  it('requires empty commands and no attached clients', () => {
    expect(isDaemonIdle({ ...idle, activeCommands: [{}] })).toBe(false)
    expect(isDaemonIdle({ ...idle, activeCommands: undefined })).toBe(false)
    expect(isDaemonIdle({ ...idle, attachedClients: 1 })).toBe(false)
    expect(isDaemonIdle({ ...idle, attachedClients: undefined })).toBe(false)
    expect(isDaemonIdle({ ...idle, attachedClients: -1 })).toBe(false)
  })
  it('treats missing, invalid and future activity as live', () => {
    expect(isDaemonIdle({ ...idle, lastActivityMs: undefined })).toBe(false)
    expect(isDaemonIdle({ ...idle, lastActivityMs: Number.NaN })).toBe(false)
    expect(isDaemonIdle({ ...idle, lastActivityMs: now + 1 })).toBe(false)
  })
})

describe('UTC blackout windows', () => {
  it('includes start and excludes end including seconds', () => {
    const blackout = [{ startUtc: '12:00', endUtc: '13:00' }]
    expect(isInBlackout({ now: now - 1, blackout })).toBe(false)
    expect(isInBlackout({ now, blackout })).toBe(true)
    expect(isInBlackout({ now: now + hour - 1, blackout })).toBe(true)
    expect(isInBlackout({ now: now + hour, blackout })).toBe(false)
  })
  it('wraps midnight in UTC', () => {
    const blackout = [{ startUtc: '23:00', endUtc: '02:00' }]
    for (const [time, expected] of [
      ['22:59', false],
      ['23:00', true],
      ['00:00', true],
      ['01:59', true],
      ['02:00', false],
    ] as const) {
      expect(isInBlackout({ now: Date.parse(`2026-10-19T${time}:00Z`), blackout })).toBe(expected)
    }
  })
  it('supports multiple windows and full-day equal endpoints', () => {
    expect(isInBlackout({ now, blackout: [] })).toBe(false)
    expect(
      isInBlackout({
        now,
        blackout: [
          { startUtc: '00:00', endUtc: '01:00' },
          { startUtc: '12:00', endUtc: '13:00' },
        ],
      }),
    ).toBe(true)
    expect(isInBlackout({ now, blackout: [{ startUtc: '03:00', endUtc: '03:00' }] })).toBe(true)
  })
})

describe('maintenance safety gates', () => {
  it('admits the exact current seat by default', () => {
    expect(decideMaintainGate(gate)).toBeUndefined()
    expect(decideMaintainGate({ ...gate, owners: ['seat/ab'] })).toBe('foreign-owner')
    expect(decideMaintainGate({ ...gate, currentAgent: undefined })).toBe('foreign-owner')
  })
  it('uses exact and glob config owners in place of the seat default', () => {
    expect(matchesMaintainOwner({ owner: 'seat/a', pattern: 'seat/a' })).toBe(true)
    expect(matchesMaintainOwner({ owner: 'seat/ab', pattern: 'seat/a' })).toBe(false)
    expect(matchesMaintainOwner({ owner: 'seat/a', pattern: 'seat/*' })).toBe(true)
    expect(
      decideMaintainGate({
        ...gate,
        currentAgent: undefined,
        owners: ['team/a', 'team/b'],
        maintainOwners: ['team/*'],
      }),
    ).toBeUndefined()
    expect(decideMaintainGate({ ...gate, maintainOwners: ['other/*'] })).toBe('foreign-owner')
    expect(
      decideMaintainGate({ ...gate, owners: ['team/a', 'foreign/a'], maintainOwners: ['team/*'] }),
    ).toBe('foreign-owner')
  })
  it('never infers missing ownership from the seat and requires explicit unowned admission', () => {
    expect(decideMaintainGate({ ...gate, owners: undefined })).toBe('unknown-owner')
    expect(decideMaintainGate({ ...gate, owners: [] })).toBe('unknown-owner')
    expect(decideMaintainGate({ ...gate, owners: [], maintainUnowned: true })).toBeUndefined()
    expect(
      decideMaintainGate({ ...gate, owners: undefined, maintainUnowned: true }),
    ).toBeUndefined()
    expect(decideMaintainGate({ ...gate, owners: ['foreign'], maintainUnowned: true })).toBe(
      'foreign-owner',
    )
  })
  const reasons: readonly [
    Partial<Parameters<typeof decideMaintainGate>[0]>,
    MaintainSkipReason,
  ][] = [
    [{ blackout: true }, 'blackout'],
    [{ gitLocked: true }, 'git-locked'],
    [{ liveHolder: true }, 'holder-live'],
    [{ liveHolder: undefined }, 'holder-census-incomplete'],
    [{ activeClaim: true }, 'active-claim'],
    [{ owners: ['other'] }, 'foreign-owner'],
    [{ owners: [] }, 'unknown-owner'],
    [{ leaseHeld: true }, 'lease-held'],
  ]
  for (const [override, reason] of reasons) {
    it(`returns stable ${reason} reason`, () =>
      expect(decideMaintainGate({ ...gate, ...override })).toBe(reason))
  }
  it('treats unknown liveness, locks, claims and leases as live', () => {
    expect(decideMaintainGate({ ...gate, gitLocked: undefined })).toBe('git-locked')
    expect(decideMaintainGate({ ...gate, liveHolder: undefined })).toBe('holder-census-incomplete')
    expect(decideMaintainGate({ ...gate, activeClaim: undefined })).toBe('active-claim')
    expect(decideMaintainGate({ ...gate, leaseHeld: undefined })).toBe('lease-held')
  })
  it('prioritizes global blackout before worktree gates', () => {
    expect(decideMaintainGate({ ...gate, blackout: true, gitLocked: true, liveHolder: true })).toBe(
      'blackout',
    )
  })
})

describe('attributed workspace process claims', () => {
  const daemon: WorkspaceActivityProcess = {
    pid: 101,
    startTime: '1001',
    executableClass: 'buck2-daemon',
  }
  const forkserver: WorkspaceActivityProcess = {
    pid: 102,
    startTime: '1002',
    executableClass: 'buck2-forkserver',
  }
  const holder: WorkspaceActivityProcess = { pid: 103, startTime: '1003', executableClass: 'other' }
  const ignored = [daemon, forkserver]
  const observed = [daemon, forkserver, holder]
  it('waives a daemon-only claim only after live process-lifetime verification', () => {
    expect(
      canIgnoreActivityProcessClaim({
        claim: { sources: ['process'], processes: [daemon, forkserver] },
        ignored,
        observed,
      }),
    ).toBe(true)
  })
  it('keeps mixed daemon and ordinary holder claims active', () => {
    expect(
      canIgnoreActivityProcessClaim({
        claim: { sources: ['process'], processes: [daemon, holder] },
        ignored,
        observed,
      }),
    ).toBe(false)
  })
  it('keeps unattributed and empty historical claims active', () => {
    expect(
      canIgnoreActivityProcessClaim({ claim: { sources: ['process'] }, ignored, observed }),
    ).toBe(false)
    expect(
      canIgnoreActivityProcessClaim({
        claim: { sources: ['process'], processes: [] },
        ignored,
        observed,
      }),
    ).toBe(false)
  })
  it('keeps seat and PTY claims even when their process attribution is daemon-only', () => {
    for (const source of ['st3-seat', 'pty'])
      expect(
        canIgnoreActivityProcessClaim({
          claim: { sources: ['process', source], processes: [daemon] },
          ignored,
          observed,
        }),
      ).toBe(false)
  })
  it('keeps reused, vanished, unrecognized and differently classified process lifetimes', () => {
    for (const live of [
      [],
      [{ ...daemon, startTime: '9999' }],
      [{ ...daemon, executableClass: 'other' as const }],
    ])
      expect(
        canIgnoreActivityProcessClaim({
          claim: { sources: ['process'], processes: [daemon] },
          ignored,
          observed: live,
        }),
      ).toBe(false)
    expect(
      canIgnoreActivityProcessClaim({
        claim: { sources: ['process'], processes: [daemon] },
        ignored: [],
        observed,
      }),
    ).toBe(false)
  })
})
