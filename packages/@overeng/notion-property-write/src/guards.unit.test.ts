import { describe, expect, it } from 'vitest'

import { allowed, blocked, propertyWriteGuardNames } from './guards.ts'

describe('property-write guard vocabulary', () => {
  it('exposes the 11 distinct guard names', () => {
    expect(new Set(propertyWriteGuardNames).size).toBe(propertyWriteGuardNames.length)
    expect(propertyWriteGuardNames.length).toBe(11)
  })

  it('includes the four new names and the seven reused names', () => {
    expect(propertyWriteGuardNames).toEqual(
      expect.arrayContaining([
        'RemoteSchemaRequired',
        'PropertyIdentityAmbiguous',
        'StaleRemoteSchema',
        'LocalSurfaceDisagreement',
        'ComputedPropertyWrite',
        'UnsupportedRemoteShape',
        'SchemaDriftAffectsIntent',
        'PropertyValueIncomplete',
        'UnavailableRelationTarget',
        'RelatedDataSourceUnshared',
        'ReadAfterWriteMismatch',
      ]),
    )
  })
})

describe('decision constructors', () => {
  it('allowed() is the allowed tag', () => {
    expect(allowed()).toEqual({ _tag: 'allowed' })
  })

  it('blocked() carries guard and message', () => {
    expect(blocked({ guard: 'StaleRemoteSchema', message: 'stale' })).toEqual({
      _tag: 'blocked',
      guard: 'StaleRemoteSchema',
      message: 'stale',
    })
  })
})
