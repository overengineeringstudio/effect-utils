import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import type { BuildIdentity } from './build-identity-types.d.ts'
import {
  formatBuildIdentityDetails,
  formatBuildIdentityShort,
  formatRelativeTime,
} from './build-identity.js'

const now = 1_800_000_000
const identity: BuildIdentity = {
  rev: 'a7647bb123456789',
  dirty: false,
  commitTs: now - 3 * 3600,
  displayVersion: '0.1.0+a7647bb — committed 3 hours ago',
  machineVersion: '0.1.0+a7647bb',
}

describe('formatRelativeTime', () => {
  it.each([
    [0, '0s'],
    [1, '1s'],
    [59, '59s'],
    [60, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [86_399, '23h'],
    [86_400, '1d'],
    [7 * 86_400, '7d'],
    [30 * 86_400 - 1, '29d'],
    [30 * 86_400, '1mo'],
    [365 * 86_400 - 1, '12mo'],
    [365 * 86_400, '1y'],
    [2 * 365 * 86_400, '2y'],
  ])('formats %i seconds as %s', (elapsed, expected) => {
    expect(formatRelativeTime({ ts: now - elapsed, now })).toBe(expected)
  })

  it('floors fractional seconds and clamps future clock skew to zero', () => {
    expect(formatRelativeTime({ ts: now - 59.9, now })).toBe('59s')
    expect(formatRelativeTime({ ts: now + 3600, now })).toBe('0s')
  })

  it('never invents an age for non-finite timestamps', () => {
    expect(formatRelativeTime({ ts: Number.NaN, now })).toBe('n/a')
    expect(formatRelativeTime({ ts: now, now: Number.POSITIVE_INFINITY })).toBe('n/a')
  })

  it.each([
    [59, 'just now'],
    [60, '1 min ago'],
    [3600, '1 hour ago'],
    [7200, '2 hours ago'],
    [86_400, '1 day ago'],
    [2 * 86_400, '2 days ago'],
    [7 * 86_400, '1 week ago'],
    [14 * 86_400, '2 weeks ago'],
  ])('preserves CLI prose for %i seconds', (elapsed, expected) => {
    expect(formatRelativeTime({ ts: now - elapsed, now, format: 'long' })).toBe(expected)
  })

  it('preserves the CLI calendar-date bucket after thirty days', () => {
    const ts = Date.UTC(2026, 0, 2, 12) / 1000
    const date = new Date(ts * 1000)
    expect(formatRelativeTime({ ts, now: ts + 30 * 86_400, format: 'long' })).toBe(
      `${date.toLocaleString('en-US', { month: 'short' })} ${date.getDate()}`,
    )
  })
})

describe('formatBuildIdentityShort', () => {
  it('renders seven revision characters and a live commit age', () => {
    expect(formatBuildIdentityShort({ identity, now })).toBe('a7647bb · 3h')
    expect(
      formatBuildIdentityShort({
        identity: { ...identity, dirty: true, commitTs: now - 2 * 86_400 },
        now,
      }),
    ).toBe('a7647bb* · 2d')
  })

  it('marks missing commit time n/a rather than substituting build/deploy time', () => {
    expect(
      formatBuildIdentityShort({
        identity: { ...identity, dirty: true, commitTs: undefined, buildTs: now - 720 },
        now,
      }),
    ).toBe('a7647bb* · n/a')
  })

  it('honestly identifies missing revisions, retaining known dirty state and age', () => {
    expect(formatBuildIdentityShort({ identity: { ...identity, rev: undefined }, now })).toBe(
      'n/a · 3h',
    )
    expect(
      formatBuildIdentityShort({
        identity: { ...identity, rev: '', dirty: true, commitTs: undefined },
        now,
      }),
    ).toBe('n/a* · n/a')
  })
})

describe('formatBuildIdentityDetails', () => {
  it('returns both supplied versions and deploy/build age as structured lines', () => {
    expect(
      formatBuildIdentityDetails({ identity: { ...identity, buildTs: now - 720 }, now }),
    ).toEqual([
      { label: 'displayVersion', value: identity.displayVersion },
      { label: 'machineVersion', value: identity.machineVersion },
      { label: 'deployed', value: '12m ago' },
    ])
  })

  it('does not treat reproducible commit time as deployment time', () => {
    expect(formatBuildIdentityDetails({ identity, now })).toEqual([
      { label: 'displayVersion', value: identity.displayVersion },
      { label: 'machineVersion', value: identity.machineVersion },
    ])
  })

  it('marks an invalid supplied build timestamp unavailable', () => {
    expect(
      formatBuildIdentityDetails({ identity: { ...identity, buildTs: Number.NaN }, now }),
    ).toContainEqual({
      label: 'deployed',
      value: 'n/a',
    })
  })
})
