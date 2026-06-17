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

type ProofShape = typeof PropertyWriteProof.Type

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
    expect(evaluatePropertyWrite(baseProof, selectDesired)._tag).toBe('allowed')
  })

  it('allows a clean shared proof (settlement present)', () => {
    const sharedProof = withProof({
      mode: 'shared',
      relationAvailability: { status: 'all-available' },
      localConvergence: { status: 'converged' },
      settlement: { status: 'present' },
    })
    expect(evaluatePropertyWrite(sharedProof, selectDesired)._tag).toBe('allowed')
  })

  it('allows an empty value against any property type', () => {
    const emptyDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'empty' },
    })
    expect(evaluatePropertyWrite(baseProof, emptyDesired)._tag).toBe('allowed')
  })
})

describe('evaluatePropertyWrite — per-guard block + allow boundary', () => {
  it('RemoteSchemaRequired', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { remoteSchemaObserved: false } }),
        selectDesired,
      ),
      'RemoteSchemaRequired',
    )
    expect(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { remoteSchemaObserved: true } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('PropertyIdentityAmbiguous', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ identity: { displayNameUnambiguous: false } }),
        selectDesired,
      ),
      'PropertyIdentityAmbiguous',
    )
    expect(
      evaluatePropertyWrite(
        withProof({ identity: { displayNameUnambiguous: true } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('StaleRemoteSchema', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({
          schemaConsistency: { observedSchemaHash: Schema.decodeSync(SchemaHash)(hashOf(99)) },
        }),
        selectDesired,
      ),
      'StaleRemoteSchema',
    )
    // Boundary: observed hash equals expected -> allowed.
    expect(
      evaluatePropertyWrite(
        withProof({
          schemaConsistency: { observedSchemaHash: baseProof.schemaConsistency.expectedSchemaHash },
        }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('ComputedPropertyWrite', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { writeClass: 'computed' } }),
        selectDesired,
      ),
      'ComputedPropertyWrite',
    )
    expect(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { writeClass: 'writable' } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('UnsupportedRemoteShape (write class)', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { writeClass: 'unsupported' } }),
        selectDesired,
      ),
      'UnsupportedRemoteShape',
    )
    // Boundary: a writable class with a fitting value is allowed.
    expect(
      evaluatePropertyWrite(
        withProof({ schemaConsistency: { writeClass: 'writable' } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('SchemaDriftAffectsIntent', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({
          schemaConsistency: { observedConfigHash: Schema.decodeSync(ConfigHash)(hashOf(99)) },
        }),
        selectDesired,
      ),
      'SchemaDriftAffectsIntent',
    )
    // Boundary: observed config equals expected config -> allowed.
    expect(
      evaluatePropertyWrite(
        withProof({
          schemaConsistency: { observedConfigHash: baseProof.schemaConsistency.expectedConfigHash },
        }),
        selectDesired,
      )._tag,
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
    expect(evaluatePropertyWrite(proof, selectDesired)._tag).toBe('allowed')
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
    expect(evaluatePropertyWrite(proof, selectDesired)._tag).toBe('allowed')
  })

  it('UnsupportedRemoteShape (value tag vs property type)', () => {
    const numberDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'number', value: 1 },
    })
    expectBlocked(evaluatePropertyWrite(baseProof, numberDesired), 'UnsupportedRemoteShape')
    // Boundary: a select value fits the select property type.
    expect(evaluatePropertyWrite(baseProof, selectDesired)._tag).toBe('allowed')
  })

  it('UnsupportedRemoteShape (computed value into writable slot)', () => {
    const computedDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'computed', valueHash: hashOf(7) },
    })
    expectBlocked(evaluatePropertyWrite(baseProof, computedDesired), 'UnsupportedRemoteShape')
  })

  it('PropertyValueIncomplete', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ baseCompleteness: { surfaceComplete: false } }),
        selectDesired,
      ),
      'PropertyValueIncomplete',
    )
    expect(
      evaluatePropertyWrite(
        withProof({ baseCompleteness: { surfaceComplete: true } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('UnavailableRelationTarget', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ relationAvailability: { status: 'targets-unavailable' } }),
        selectDesired,
      ),
      'UnavailableRelationTarget',
    )
    expect(
      evaluatePropertyWrite(
        withProof({ relationAvailability: { status: 'all-available' } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('RelatedDataSourceUnshared', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ relationAvailability: { status: 'related-data-source-unshared' } }),
        selectDesired,
      ),
      'RelatedDataSourceUnshared',
    )
    // Boundary: a shared, all-available relation is allowed.
    expect(
      evaluatePropertyWrite(
        withProof({ relationAvailability: { status: 'all-available' } }),
        selectDesired,
      )._tag,
    ).toBe('allowed')
  })

  it('LocalSurfaceDisagreement', () => {
    expectBlocked(
      evaluatePropertyWrite(
        withProof({ localConvergence: { status: 'disagrees' } }),
        selectDesired,
      ),
      'LocalSurfaceDisagreement',
    )
    expect(
      evaluatePropertyWrite(withProof({ localConvergence: { status: 'converged' } }), selectDesired)
        ._tag,
    ).toBe('allowed')
  })

  it('ReadAfterWriteMismatch', () => {
    expectBlocked(
      evaluatePropertyWrite(withProof({ settlement: { status: 'missing' } }), selectDesired),
      'ReadAfterWriteMismatch',
    )
    expect(
      evaluatePropertyWrite(withProof({ settlement: { status: 'present' } }), selectDesired)._tag,
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
    expectBlocked(evaluatePropertyWrite(multiViolation, selectDesired), 'RemoteSchemaRequired')
  })

  it('identity ambiguity outranks a later base-completeness violation', () => {
    const proof = withProof({
      identity: { displayNameUnambiguous: false },
      baseCompleteness: { surfaceComplete: false },
    })
    expectBlocked(evaluatePropertyWrite(proof, selectDesired), 'PropertyIdentityAmbiguous')
  })

  it('write-class (check 4) outranks config drift (check 5)', () => {
    const proof = withProof({
      schemaConsistency: {
        writeClass: 'computed',
        observedConfigHash: Schema.decodeSync(ConfigHash)(hashOf(99)),
      },
    })
    expectBlocked(evaluatePropertyWrite(proof, selectDesired), 'ComputedPropertyWrite')
  })

  it('value/type fit (check 6) outranks base incompleteness (check 7)', () => {
    const numberDesired = makeDesired({
      propertyId: 'prop_status',
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      value: { _tag: 'number', value: 1 },
    })
    const proof = withProof({ baseCompleteness: { surfaceComplete: false } })
    expectBlocked(evaluatePropertyWrite(proof, numberDesired), 'UnsupportedRemoteShape')
  })

  it('relation availability (check 8) outranks local disagreement (check 9)', () => {
    const proof = withProof({
      relationAvailability: { status: 'targets-unavailable' },
      localConvergence: { status: 'disagrees' },
    })
    expectBlocked(evaluatePropertyWrite(proof, selectDesired), 'UnavailableRelationTarget')
  })

  it('local disagreement (check 9) outranks missing settlement (check 10)', () => {
    const proof = withProof({
      localConvergence: { status: 'disagrees' },
      settlement: { status: 'missing' },
    })
    expectBlocked(evaluatePropertyWrite(proof, selectDesired), 'LocalSurfaceDisagreement')
  })
})
