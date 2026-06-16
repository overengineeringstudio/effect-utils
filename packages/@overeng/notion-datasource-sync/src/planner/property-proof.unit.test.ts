import { describe, expect, it } from 'vitest'

import { evaluatePropertyWrite } from '@overeng/notion-property-write'

import { hash, testIds } from '../testing/harness.ts'
import {
  evaluateDesiredFileReferences,
  makeWorkspaceProof,
  type WorkspaceProofInputs,
} from './property-proof.ts'

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

const fileValue = (file: {
  name: string
  externalUrl?: string
}): WorkspaceProofInputs['desiredValue'] => ({
  _tag: 'files',
  files: [
    {
      _tag: 'CanonicalFileValue',
      name: file.name,
      identityHash: `sha256:${file.name}`,
      ...(file.externalUrl === undefined ? {} : { externalUrl: file.externalUrl }),
    },
  ],
})

describe('evaluateDesiredFileReferences (ExpiringFileUrl dispatch — decision 0016 part 2)', () => {
  it('blocks a files write whose value carries a Notion-hosted (no externalUrl) file', () => {
    expect(evaluateDesiredFileReferences(fileValue({ name: 'report.pdf' }))).toMatchObject({
      _tag: 'blocked',
      guard: 'ExpiringFileUrl',
    })
  })

  it('allows a files write whose value carries an external durable URL', () => {
    expect(
      evaluateDesiredFileReferences(
        fileValue({ name: 'report.pdf', externalUrl: 'https://example.com/report.pdf' }),
      ),
    ).toEqual({ _tag: 'allowed' })
  })

  it('blocks when ANY file lacks an externalUrl (mirrors the encode-path fail-closed posture)', () => {
    expect(
      evaluateDesiredFileReferences({
        _tag: 'files',
        files: [
          {
            _tag: 'CanonicalFileValue',
            name: 'a.pdf',
            identityHash: 'sha256:a',
            externalUrl: 'https://x/a.pdf',
          },
          { _tag: 'CanonicalFileValue', name: 'b.pdf', identityHash: 'sha256:b' },
        ],
      }),
    ).toMatchObject({ _tag: 'blocked', guard: 'ExpiringFileUrl' })
  })

  it('allows an empty files value (a clear, not an expiring ref)', () => {
    expect(evaluateDesiredFileReferences({ _tag: 'files', files: [] })).toEqual({ _tag: 'allowed' })
  })

  it('allows non-files writes (no file reference to evaluate)', () => {
    expect(evaluateDesiredFileReferences({ _tag: 'title', plainText: 'x' })).toEqual({
      _tag: 'allowed',
    })
    expect(evaluateDesiredFileReferences({ _tag: 'empty' })).toEqual({ _tag: 'allowed' })
  })

  it('the property-write core ALLOWS a notion-hosted files write, so the file-ref guard is what fails closed', () => {
    // Regression: the core's tag-fit is a no-op (a `files` value fits a `files`
    // column), so `evaluatePropertyWrite` allows. The ExpiringFileUrl block must
    // therefore come from the separate file-reference dispatch, not the core.
    const desiredValue = fileValue({ name: 'report.pdf' })
    expect(evaluate({ writeClass: 'writable', desiredValue })).toEqual({ _tag: 'allowed' })
    expect(evaluateDesiredFileReferences(desiredValue)).toMatchObject({
      _tag: 'blocked',
      guard: 'ExpiringFileUrl',
    })
  })
})
