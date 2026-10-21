import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  formatBuildIdentityDetails,
  formatBuildIdentityShort,
  formatRelativeTime,
} from './build-identity.js'
import golden from './fixtures/build-identity-goldens.json' with { type: 'json' }
import { resolveCliBuildIdentity } from './node/cli-build-identity.js'

describe('portable build identity contract', () => {
  it.each(golden.identities)('formats $machineVersion', (fixture) => {
    const identity = {
      ...fixture.stamp,
      displayVersion: fixture.displayVersion,
      machineVersion: fixture.machineVersion,
    }
    expect(formatBuildIdentityShort({ identity, now: golden.now })).toBe(fixture.short)
    expect(formatBuildIdentityDetails({ identity, now: golden.now })).toEqual(fixture.details)
  })

  it.each(golden.relativeTimes)('formats compact elapsed $elapsed', ({ elapsed, value }) => {
    expect(formatRelativeTime({ ts: 0, now: elapsed })).toBe(value)
  })

  it.each(golden.longRelativeTimes)('formats long elapsed $elapsed', ({ elapsed, value }) => {
    expect(formatRelativeTime({ ts: 0, now: elapsed, format: 'long' })).toBe(value)
  })

  it('preserves supplied display/machine values and missing commit age', () => {
    const fixture = golden.suppliedIdentity
    expect(formatBuildIdentityShort({ identity: fixture.identity, now: golden.now })).toBe(
      fixture.short,
    )
    expect(formatBuildIdentityDetails({ identity: fixture.identity, now: golden.now })).toEqual(
      fixture.details,
    )
  })

  it.each(golden.cliCases)('resolves CLI stamp $name', (fixture) => {
    const identity = resolveCliBuildIdentity({
      baseVersion: fixture.baseVersion,
      buildStamp: fixture.buildStamp,
      env: fixture.environment,
      now: golden.now,
    })
    expect(identity.machineVersion).toBe(fixture.machineVersion)
    expect(identity.displayVersion).toBe(fixture.displayVersion)
  })
})
