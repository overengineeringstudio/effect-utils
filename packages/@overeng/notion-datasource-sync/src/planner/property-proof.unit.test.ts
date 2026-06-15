import { describe, expect, it } from 'vitest'

import { evaluatePropertyWrite } from '@overeng/notion-property-write'

import { hash, testIds } from '../testing/harness.ts'
import { makeWorkspaceProof, type WorkspaceProofInputs } from './property-proof.ts'

const baseInputs = (overrides: Partial<WorkspaceProofInputs> = {}): WorkspaceProofInputs => ({
  dataSourceId: testIds.dataSourceId,
  propertyId: testIds.propertyA,
  desiredValue: { _tag: 'title', plainText: 'Updated' },
  writeClass: 'writable',
  observedSchemaHash: hash('schema'),
  observedConfigHash: hash('config'),
  expectedConfigHash: hash('config'),
  availability: 'complete',
  ...overrides,
})

const evaluate = (overrides: Partial<WorkspaceProofInputs> = {}) => {
  const { proof, desiredWrite } = makeWorkspaceProof(baseInputs(overrides))
  return evaluatePropertyWrite(proof, desiredWrite)
}

describe('makeWorkspaceProof', () => {
  it('allows an ordinary shared-mode write with a settled, converged surface', () => {
    expect(evaluate()).toEqual({ _tag: 'allowed' })
  })

  it('omits expectedSchemaHash when no authored whole-schema oracle is carried', () => {
    const { proof } = makeWorkspaceProof(baseInputs())
    expect(proof.schemaConsistency.observedSchemaHash).toBeDefined()
    expect(proof.schemaConsistency.expectedSchemaHash).toBeUndefined()
    // With expectedSchemaHash omitted, the StaleRemoteSchema check honestly skips.
    expect(evaluate()).toEqual({ _tag: 'allowed' })
  })

  it('blocks with StaleRemoteSchema only when both schema hashes are present and differ', () => {
    expect(
      evaluate({ observedSchemaHash: hash('a'), expectedSchemaHash: hash('b') }),
    ).toMatchObject({ _tag: 'blocked', guard: 'StaleRemoteSchema' })
    expect(evaluate({ observedSchemaHash: hash('a'), expectedSchemaHash: hash('a') })).toEqual({
      _tag: 'allowed',
    })
  })

  it('fills shared-mode defaults: settlement present, localConvergence not-applicable', () => {
    const { proof } = makeWorkspaceProof(baseInputs())
    expect(proof.mode).toBe('shared')
    expect(proof.settlement.status).toBe('present')
    expect(proof.localConvergence.status).toBe('not-applicable')
  })

  it('blocks LocalSurfaceDisagreement when the local surface disagrees', () => {
    expect(evaluate({ localConvergence: 'disagrees' })).toMatchObject({
      _tag: 'blocked',
      guard: 'LocalSurfaceDisagreement',
    })
  })

  it('blocks ReadAfterWriteMismatch when settlement is missing', () => {
    expect(evaluate({ settlement: 'missing' })).toMatchObject({
      _tag: 'blocked',
      guard: 'ReadAfterWriteMismatch',
    })
  })

  it('routes availability onto base completeness and relation surfaces', () => {
    expect(evaluate({ availability: 'paginated-incomplete' })).toMatchObject({
      _tag: 'blocked',
      guard: 'PropertyValueIncomplete',
    })
    expect(evaluate({ availability: 'relation-target-inaccessible' })).toMatchObject({
      _tag: 'blocked',
      guard: 'UnavailableRelationTarget',
    })
    expect(evaluate({ availability: 'related-data-source-unshared' })).toMatchObject({
      _tag: 'blocked',
      guard: 'RelatedDataSourceUnshared',
    })
    expect(evaluate({ availability: 'unsupported' })).toMatchObject({
      _tag: 'blocked',
      guard: 'UnsupportedRemoteShape',
    })
  })

  it('blocks an unsupported-availability write to a clear-to-empty value (value-independent, no fail-open)', () => {
    // Regression: a clear-to-`empty` value must still be blocked. Routing the
    // unsupported block through value tag-fit (core check 6) would fail OPEN
    // because `empty` fits any property type; it must route through write class.
    expect(
      evaluate({ availability: 'unsupported', desiredValue: { _tag: 'empty' } }),
    ).toMatchObject({ _tag: 'blocked', guard: 'UnsupportedRemoteShape' })
  })

  it('blocks RemoteSchemaRequired / PropertyIdentityAmbiguous from the schema-observation signals', () => {
    expect(evaluate({ remoteSchemaObserved: false })).toMatchObject({
      _tag: 'blocked',
      guard: 'RemoteSchemaRequired',
    })
    expect(evaluate({ displayNameUnambiguous: false })).toMatchObject({
      _tag: 'blocked',
      guard: 'PropertyIdentityAmbiguous',
    })
  })

  it('blocks ComputedPropertyWrite / SchemaDriftAffectsIntent from the schema consistency surface', () => {
    expect(evaluate({ writeClass: 'computed' })).toMatchObject({
      _tag: 'blocked',
      guard: 'ComputedPropertyWrite',
    })
    expect(
      evaluate({ observedConfigHash: hash('x'), expectedConfigHash: hash('y') }),
    ).toMatchObject({ _tag: 'blocked', guard: 'SchemaDriftAffectsIntent' })
  })

  it('builds the proof and desired write for the same (dataSourceId, propertyId) pair', () => {
    const { proof, desiredWrite } = makeWorkspaceProof(baseInputs())
    expect(desiredWrite.propertyId).toBe(proof.identity.propertyId)
    expect(desiredWrite.dataSourceId).toBe(proof.dataSourceId)
  })
})
