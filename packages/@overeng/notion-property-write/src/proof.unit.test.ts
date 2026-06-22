import { Effect, Exit, type ParseResult } from 'effect'
import { describe, expect, it } from 'vitest'

import { decodeDesiredPropertyWrite, decodePropertyWriteProof } from './proof.ts'

const hashOf = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`

const validProof = {
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
}

const validDesired = {
  propertyId: 'prop_status',
  dataSourceId: '00000000-0000-4000-8000-000000000002',
  value: { _tag: 'select', option: null },
}

const isFailure = <A>(exit: Exit.Exit<A, unknown>): boolean => Exit.isFailure(exit)
const run = <A>(effect: Effect.Effect<A, ParseResult.ParseError>): Exit.Exit<A, unknown> =>
  Effect.runSyncExit(effect)

describe('decodePropertyWriteProof', () => {
  it('accepts a valid proof', () => {
    expect(Exit.isSuccess(run(decodePropertyWriteProof(validProof)))).toBe(true)
  })

  it('rejects unknown top-level fields (fails closed)', () => {
    expect(isFailure(run(decodePropertyWriteProof({ ...validProof, liveHandle: {} })))).toBe(true)
  })

  it('rejects unknown nested fields (fails closed)', () => {
    const withExcessNested = {
      ...validProof,
      schemaConsistency: { ...validProof.schemaConsistency, liveSchema: {} },
    }
    expect(isFailure(run(decodePropertyWriteProof(withExcessNested)))).toBe(true)
  })

  it('rejects a missing required field', () => {
    const { settlement: _omitted, ...withoutSettlement } = validProof
    expect(isFailure(run(decodePropertyWriteProof(withoutSettlement)))).toBe(true)
  })

  it('rejects an invalid status literal', () => {
    const badRelation = { ...validProof, relationAvailability: { status: 'maybe' } }
    expect(isFailure(run(decodePropertyWriteProof(badRelation)))).toBe(true)
  })

  it('accepts the optional observed hashes', () => {
    const withObserved = {
      ...validProof,
      schemaConsistency: {
        ...validProof.schemaConsistency,
        observedSchemaHash: hashOf(1),
        observedConfigHash: hashOf(2),
      },
    }
    expect(Exit.isSuccess(run(decodePropertyWriteProof(withObserved)))).toBe(true)
  })

  it('accepts a proof that omits the optional expected hashes', () => {
    // A standalone provider with no authored schema/config-hash oracle omits
    // both expected hashes; the proof must still decode (the staleness checks
    // skip rather than fabricate a comparison).
    const {
      expectedSchemaHash: _omitSchema,
      expectedConfigHash: _omitConfig,
      ...schemaWithoutExpected
    } = validProof.schemaConsistency
    const withoutExpected = { ...validProof, schemaConsistency: schemaWithoutExpected }
    expect(Exit.isSuccess(run(decodePropertyWriteProof(withoutExpected)))).toBe(true)
  })
})

describe('decodeDesiredPropertyWrite', () => {
  it('accepts a valid desired write', () => {
    expect(Exit.isSuccess(run(decodeDesiredPropertyWrite(validDesired)))).toBe(true)
  })

  it('rejects unknown fields (fails closed)', () => {
    expect(isFailure(run(decodeDesiredPropertyWrite({ ...validDesired, raw: {} })))).toBe(true)
  })

  it('rejects a missing required field', () => {
    const { value: _omitted, ...withoutValue } = validDesired
    expect(isFailure(run(decodeDesiredPropertyWrite(withoutValue)))).toBe(true)
  })
})
