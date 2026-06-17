import { describe, expect, it } from 'vitest'

import { evaluatePropertyWrite } from '@overeng/notion-property-write'

import { hash, testIds } from '../testing/harness.ts'
import {
  evaluateDesiredFileReferences,
  isExpiringExternalUrl,
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

describe('evaluateDesiredFileReferences (ExpiringFileUrl dispatch — decision 0024 part 2)', () => {
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

  // Decision 0016 part 3: durability is a property of the URL, not its source. An
  // OBVIOUSLY-expiring EXTERNAL URL (presign/expiry signature) fails closed
  // alongside the notion-hosted case; a durable external URL stays allowed.
  it('blocks an external URL carrying an AWS S3 presign signature', () => {
    expect(
      evaluateDesiredFileReferences(
        fileValue({
          name: 'report.pdf',
          externalUrl:
            'https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123&X-Amz-Expires=3600',
        }),
      ),
    ).toMatchObject({ _tag: 'blocked', guard: 'ExpiringFileUrl' })
  })

  it('blocks an external URL carrying an Azure SAS signature', () => {
    expect(
      evaluateDesiredFileReferences(
        fileValue({
          name: 'report.pdf',
          externalUrl:
            'https://acct.blob.core.windows.net/c/report.pdf?sig=abc%3D&se=2026-01-01T00%3A00%3A00Z&sp=r',
        }),
      ),
    ).toMatchObject({ _tag: 'blocked', guard: 'ExpiringFileUrl' })
  })

  it('blocks an external URL carrying a GCS signed-URL signature', () => {
    expect(
      evaluateDesiredFileReferences(
        fileValue({
          name: 'report.pdf',
          externalUrl:
            'https://storage.googleapis.com/bucket/report.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=def456&X-Goog-Expires=900',
        }),
      ),
    ).toMatchObject({ _tag: 'blocked', guard: 'ExpiringFileUrl' })
  })

  it('allows a durable external URL with benign query params (not a presign signature)', () => {
    expect(
      evaluateDesiredFileReferences(
        fileValue({
          name: 'report.pdf',
          externalUrl: 'https://example.com/report.pdf?utm_source=newsletter&v=2',
        }),
      ),
    ).toEqual({ _tag: 'allowed' })
  })
})

describe('isExpiringExternalUrl (decision 0024 part 3 — URL durability, not source)', () => {
  it('flags AWS S3 presigned URLs (any of X-Amz-Signature/Expires/Credential)', () => {
    expect(isExpiringExternalUrl('https://b.s3.amazonaws.com/o?X-Amz-Signature=x')).toBe(true)
    expect(isExpiringExternalUrl('https://b.s3.amazonaws.com/o?X-Amz-Expires=3600')).toBe(true)
    expect(isExpiringExternalUrl('https://b.s3.amazonaws.com/o?x-amz-credential=cred')).toBe(true)
  })

  it('flags Azure SAS only when sig is paired with se/st (sig alone is too generic)', () => {
    expect(isExpiringExternalUrl('https://a.blob.core.windows.net/c/o?sig=s&se=2026-01-01')).toBe(
      true,
    )
    expect(isExpiringExternalUrl('https://a.blob.core.windows.net/c/o?sig=s&st=2025-01-01')).toBe(
      true,
    )
    expect(isExpiringExternalUrl('https://a.blob.core.windows.net/c/o?sig=s')).toBe(false)
  })

  it('flags GCS signed URLs and generic presign/expiry shapes', () => {
    expect(isExpiringExternalUrl('https://storage.googleapis.com/b/o?X-Goog-Signature=g')).toBe(
      true,
    )
    expect(isExpiringExternalUrl('https://storage.googleapis.com/b/o?X-Goog-Expires=900')).toBe(
      true,
    )
    expect(isExpiringExternalUrl('https://cdn.example.com/o?Signature=s&Expires=99')).toBe(true)
    expect(isExpiringExternalUrl('https://cdn.example.com/o?Expires=1735689600')).toBe(true)
    expect(isExpiringExternalUrl('https://api.example.com/o?token=t&exp=1735689600')).toBe(true)
  })

  it('treats durable URLs (no query, benign params) as not expiring', () => {
    expect(isExpiringExternalUrl('https://example.com/file.pdf')).toBe(false)
    expect(isExpiringExternalUrl('https://example.com/file.pdf?utm_source=x&v=2')).toBe(false)
    // A bare `token` API key without an `exp` companion is not an expiry signature.
    expect(isExpiringExternalUrl('https://api.example.com/o?token=abc')).toBe(false)
    // A non-numeric `Expires` (not a unix ts) is not flagged on its own.
    expect(isExpiringExternalUrl('https://cdn.example.com/o?expires=never')).toBe(false)
  })

  it('treats a malformed/non-parseable URL as not expiring (no detectable signature, no throw)', () => {
    // Fail-OPEN choice for malformed URLs: a non-parseable string carries no
    // DETECTABLE expiry signature, so the honest verdict is "no evidence of
    // expiry" rather than a throw. The notion-hosted fail-closed case still
    // covers the no-externalUrl path; this only governs the expiry SIGNATURE
    // detector. Documented in the ADR's residual-limitation note.
    expect(isExpiringExternalUrl('not a url')).toBe(false)
    expect(isExpiringExternalUrl('')).toBe(false)
    expect(isExpiringExternalUrl('://missing-scheme')).toBe(false)
  })
})
