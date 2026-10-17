import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { ConfigHash, SchemaHash } from '@overeng/notion-effect-schema'

import { evaluatePropertyWrite } from './core.ts'
import type { PropertyWriteGuardName } from './guards.ts'
import { DesiredPropertyWrite, PropertyWriteProof } from './proof.ts'

const hashOf = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`

const makeProof = Schema.decodeSync(PropertyWriteProof)
const makeDesired = Schema.decodeSync(DesiredPropertyWrite)

const baseProof = makeProof({
  mode: 'local',
  dataSourceId: '00000000-0000-4000-8000-000000000002',
  identity: {
    propertyId: 'prop_status',
    resolvedName: 'Status',
    evidenceSource: { _tag: 'live_schema' },
    displayNameUnambiguous: true,
  },
  schemaConsistency: {
    remoteSchemaObserved: true,
    expectedSchemaHash: hashOf(1),
    expectedConfigHash: hashOf(2),
    propertyType: 'select',
    writeClass: 'writable',
  },
  baseCompleteness: { surfaceComplete: true },
  relationAvailability: { status: 'not-applicable' },
  localConvergence: { status: 'not-applicable' },
  settlement: { status: 'not-required' },
})

/** A select value that fits the base proof's `select` property type. */
const selectDesired = makeDesired({
  propertyId: 'prop_status',
  dataSourceId: '00000000-0000-4000-8000-000000000002',
  value: { _tag: 'select', option: null },
})

type ProofShape = PropertyWriteProof

/** Structurally clone the base proof with a deep override of named sections. */
const withProof = (overrides: {
  readonly [K in keyof ProofShape]?: Partial<ProofShape[K]>
}): ProofShape => ({
  ...baseProof,
  schemaConsistency: { ...baseProof.schemaConsistency, ...overrides.schemaConsistency },
  identity: { ...baseProof.identity, ...overrides.identity },
  baseCompleteness: { ...baseProof.baseCompleteness, ...overrides.baseCompleteness },
  relationAvailability: { ...baseProof.relationAvailability, ...overrides.relationAvailability },
  localConvergence: { ...baseProof.localConvergence, ...overrides.localConvergence },
  settlement: { ...baseProof.settlement, ...overrides.settlement },
  ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
})

const expectBlocked = (
  decision: ReturnType<typeof evaluatePropertyWrite>,
  guard: PropertyWriteGuardName,
): void => {
  expect(decision._tag).toBe('blocked')
  if (decision._tag === 'blocked') {
    expect(decision.guard).toBe(guard)
  }
}

describe('evaluatePropertyWrite — allow', () => {
  it('allows a clean local proof', () => {
    expect(evaluatePropertyWrite({ proof: baseProof, desiredWrite: selectDesired })._tag).toBe(
      'allowed',
    )
  })

  it('allows a clean shared proof (settlement present)', () => {
    const sharedProof = withProof({
      mode: 'shared',
      relationAvailability: { status: 'all-available' },
      localConvergence: { status: 'converged' },
      settlement: { status: 'present' },
    })
    expect(evaluatePropertyWrite({ proof: sharedProof, desiredWrite: selectDesired })._tag).toBe(
      'allowed',
    )
  })

  it('allows an empty value against any property type', () => {
    const emptyDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'empty' },
    })
    expect(evaluatePropertyWrite({ proof: baseProof, desiredWrite: emptyDesired })._tag).toBe(
      'allowed',
    )
  })
})

describe('evaluatePropertyWrite — per-guard block + allow boundary', () => {
  it('RemoteSchemaRequired', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { remoteSchemaObserved: false } }),
        desiredWrite: selectDesired,
      }),
      'RemoteSchemaRequired',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { remoteSchemaObserved: true } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('PropertyIdentityAmbiguous', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ identity: { displayNameUnambiguous: false } }),
        desiredWrite: selectDesired,
      }),
      'PropertyIdentityAmbiguous',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ identity: { displayNameUnambiguous: true } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('StaleRemoteSchema', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({
          schemaConsistency: { observedSchemaHash: Schema.decodeSync(SchemaHash)(hashOf(99)) },
        }),
        desiredWrite: selectDesired,
      }),
      'StaleRemoteSchema',
    )
    // Boundary: observed hash equals expected -> allowed.
    expect(
      evaluatePropertyWrite({
        proof: withProof({
          schemaConsistency: { observedSchemaHash: baseProof.schemaConsistency.expectedSchemaHash },
        }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('ComputedPropertyWrite', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { writeClass: 'computed' } }),
        desiredWrite: selectDesired,
      }),
      'ComputedPropertyWrite',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { writeClass: 'writable' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('UnsupportedRemoteShape (write class)', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { writeClass: 'unsupported' } }),
        desiredWrite: selectDesired,
      }),
      'UnsupportedRemoteShape',
    )
    // Boundary: a writable class with a fitting value is allowed.
    expect(
      evaluatePropertyWrite({
        proof: withProof({ schemaConsistency: { writeClass: 'writable' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('SchemaDriftAffectsIntent', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({
          schemaConsistency: { observedConfigHash: Schema.decodeSync(ConfigHash)(hashOf(99)) },
        }),
        desiredWrite: selectDesired,
      }),
      'SchemaDriftAffectsIntent',
    )
    // Boundary: observed config equals expected config -> allowed.
    expect(
      evaluatePropertyWrite({
        proof: withProof({
          schemaConsistency: { observedConfigHash: baseProof.schemaConsistency.expectedConfigHash },
        }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('skips StaleRemoteSchema when expectedSchemaHash is omitted (observed without authored expectation)', () => {
    // A standalone provider with a fresh read but no authored schema-hash oracle
    // omits expectedSchemaHash; the check must skip, not fabricate a comparison.
    const { expectedSchemaHash: _omit, ...schemaWithoutExpected } = baseProof.schemaConsistency
    const proof: ProofShape = {
      ...baseProof,
      schemaConsistency: {
        ...schemaWithoutExpected,
        observedSchemaHash: Schema.decodeSync(SchemaHash)(hashOf(99)),
      },
    }
    expect(evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired })._tag).toBe(
      'allowed',
    )
  })

  it('skips SchemaDriftAffectsIntent when expectedConfigHash is omitted (observed without authored expectation)', () => {
    const { expectedConfigHash: _omit, ...schemaWithoutExpected } = baseProof.schemaConsistency
    const proof: ProofShape = {
      ...baseProof,
      schemaConsistency: {
        ...schemaWithoutExpected,
        observedConfigHash: Schema.decodeSync(ConfigHash)(hashOf(99)),
      },
    }
    expect(evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired })._tag).toBe(
      'allowed',
    )
  })

  it('UnsupportedRemoteShape (value tag vs property type)', () => {
    const numberDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'number', value: 1 },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: baseProof, desiredWrite: numberDesired }),
      'UnsupportedRemoteShape',
    )
    // Boundary: a select value fits the select property type.
    expect(evaluatePropertyWrite({ proof: baseProof, desiredWrite: selectDesired })._tag).toBe(
      'allowed',
    )
  })

  it('UnsupportedRemoteShape (computed value into writable slot)', () => {
    const computedDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'computed', valueHash: hashOf(7) },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: baseProof, desiredWrite: computedDesired }),
      'UnsupportedRemoteShape',
    )
  })

  it('PropertyValueIncomplete', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ baseCompleteness: { surfaceComplete: false } }),
        desiredWrite: selectDesired,
      }),
      'PropertyValueIncomplete',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ baseCompleteness: { surfaceComplete: true } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('UnavailableRelationTarget', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ relationAvailability: { status: 'targets-unavailable' } }),
        desiredWrite: selectDesired,
      }),
      'UnavailableRelationTarget',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ relationAvailability: { status: 'all-available' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('RelatedDataSourceUnshared', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ relationAvailability: { status: 'related-data-source-unshared' } }),
        desiredWrite: selectDesired,
      }),
      'RelatedDataSourceUnshared',
    )
    // Boundary: a shared, all-available relation is allowed.
    expect(
      evaluatePropertyWrite({
        proof: withProof({ relationAvailability: { status: 'all-available' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('LocalSurfaceDisagreement', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ localConvergence: { status: 'disagrees' } }),
        desiredWrite: selectDesired,
      }),
      'LocalSurfaceDisagreement',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ localConvergence: { status: 'converged' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })

  it('ReadAfterWriteMismatch', () => {
    expectBlocked(
      evaluatePropertyWrite({
        proof: withProof({ settlement: { status: 'missing' } }),
        desiredWrite: selectDesired,
      }),
      'ReadAfterWriteMismatch',
    )
    expect(
      evaluatePropertyWrite({
        proof: withProof({ settlement: { status: 'present' } }),
        desiredWrite: selectDesired,
      })._tag,
    ).toBe('allowed')
  })
})

describe('evaluatePropertyWrite — guard order', () => {
  it('returns the first violated guard when several invariants fail', () => {
    // Violates checks 1, 2, 7, and 10; check 1 (RemoteSchemaRequired) must win.
    const multiViolation = withProof({
      schemaConsistency: { remoteSchemaObserved: false },
      identity: { displayNameUnambiguous: false },
      baseCompleteness: { surfaceComplete: false },
      settlement: { status: 'missing' },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: multiViolation, desiredWrite: selectDesired }),
      'RemoteSchemaRequired',
    )
  })

  it('identity ambiguity outranks a later base-completeness violation', () => {
    const proof = withProof({
      identity: { displayNameUnambiguous: false },
      baseCompleteness: { surfaceComplete: false },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired }),
      'PropertyIdentityAmbiguous',
    )
  })

  it('write-class (check 4) outranks config drift (check 5)', () => {
    const proof = withProof({
      schemaConsistency: {
        writeClass: 'computed',
        observedConfigHash: Schema.decodeSync(ConfigHash)(hashOf(99)),
      },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired }),
      'ComputedPropertyWrite',
    )
  })

  it('value/type fit (check 6) outranks base incompleteness (check 7)', () => {
    const numberDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'number', value: 1 },
    })
    const proof = withProof({ baseCompleteness: { surfaceComplete: false } })
    expectBlocked(
      evaluatePropertyWrite({ proof: proof, desiredWrite: numberDesired }),
      'UnsupportedRemoteShape',
    )
  })

  it('relation availability (check 8) outranks local disagreement (check 9)', () => {
    const proof = withProof({
      relationAvailability: { status: 'targets-unavailable' },
      localConvergence: { status: 'disagrees' },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired }),
      'UnavailableRelationTarget',
    )
  })

  it('local disagreement (check 9) outranks missing settlement (check 10)', () => {
    const proof = withProof({
      localConvergence: { status: 'disagrees' },
      settlement: { status: 'missing' },
    })
    expectBlocked(
      evaluatePropertyWrite({ proof: proof, desiredWrite: selectDesired }),
      'LocalSurfaceDisagreement',
    )
  })
})
