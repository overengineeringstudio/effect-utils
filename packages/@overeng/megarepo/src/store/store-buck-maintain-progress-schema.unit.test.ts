import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BuckMaintainProgressError,
  BuckMaintainProgressManifestSchema,
  BuckMaintainProgressRecordSchema,
  canonicalBuckMaintainJson,
  validateBuckMaintainProgressOptions,
} from './store-buck-maintain-progress-schema.ts'

describe('Buck maintenance checkpoint options', () => {
  it('preserves stateless acting and report-only calls', () => {
    for (const dryRun of [false, true])
      expect(
        validateBuckMaintainProgressOptions({
          dryRun,
          progressDir: undefined,
          maxWorktrees: undefined,
        }),
      ).toBeUndefined()
  })

  it.each([
    { dryRun: false, progressDir: '/progress', maxWorktrees: undefined },
    { dryRun: true, progressDir: undefined, maxWorktrees: 1 },
    { dryRun: true, progressDir: '', maxWorktrees: 1 },
    { dryRun: true, progressDir: ' ', maxWorktrees: 1 },
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
      (maxWorktrees) => ({ dryRun: true, progressDir: '/progress', maxWorktrees }),
    ),
  ])('fails closed for invalid options: %j', (options) => {
    expect(validateBuckMaintainProgressOptions(options)?._tag).toBe('BuckMaintainProgressError')
  })

  it('accepts a bounded explicit dry run', () => {
    expect(
      validateBuckMaintainProgressOptions({
        dryRun: true,
        progressDir: '/progress',
        maxWorktrees: 2,
      }),
    ).toBeUndefined()
  })

  it('canonicalizes object keys recursively, omits absent fields, and retains array order', () => {
    expect(canonicalBuckMaintainJson({ z: undefined, b: { z: 2, a: 1 }, a: [2, 1] })).toBe(
      canonicalBuckMaintainJson({ a: [2, 1], b: { a: 1, z: 2 } }),
    )
    expect(canonicalBuckMaintainJson({ a: [2, 1] })).not.toBe(
      canonicalBuckMaintainJson({ a: [1, 2] }),
    )
  })

  it.each([
    { value: undefined },
    { value: () => undefined },
    { value: Symbol('unsupported') },
    { value: 1n },
    { value: new Date(0) },
    { value: new Map([['key', 1]]) },
    { value: new Set([1]) },
    { value: new Array<unknown>(1) },
  ])('rejects unsupported JSON values instead of erasing them: %#', ({ value }) => {
    expect(() => canonicalBuckMaintainJson({ nested: [value] })).toThrow(BuckMaintainProgressError)
  })
})

describe('serialized checkpoint contract', () => {
  const runtime = {
    entrypoint: '/immutable/mr',
    entrypointSha256: 'a'.repeat(64),
    executable: '/immutable/runtime',
    executableSha256: 'b'.repeat(64),
    platform: 'linux',
    arch: 'arm64',
  }
  const manifest = {
    version: 1,
    dryRun: true,
    runtime,
    configuration: '{}',
    inventory: ['/worktree'],
    createdAt: 1,
  }
  const record = {
    version: 1,
    manifestSha256: 'a'.repeat(64),
    recordSha256: 'b'.repeat(64),
    index: 0,
    entry: {
      worktree: '/worktree',
      action: 'none',
      reason: 'unknown',
      bytesBefore: null,
      bytesAfter: null,
      daemon: [],
      ownerEvidence: [],
    },
    capture: { startedAt: 1, completedAt: 2, elapsedMs: 1 },
  }
  const decodeManifest = Schema.decodeSync(
    Schema.fromJsonString(BuckMaintainProgressManifestSchema),
    { onExcessProperty: 'error' },
  )
  const decodeRecord = Schema.decodeSync(Schema.fromJsonString(BuckMaintainProgressRecordSchema), {
    onExcessProperty: 'error',
  })

  it('round-trips canonical manifest and null-byte observation records', () => {
    expect(decodeManifest(canonicalBuckMaintainJson(manifest))).toEqual(manifest)
    expect(decodeRecord(canonicalBuckMaintainJson(record))).toEqual(record)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite byte observations instead of converting them to null: %s',
    (bytes) => {
      for (const field of ['bytesBefore', 'bytesAfter'] as const)
        expect(() =>
          canonicalBuckMaintainJson({ ...record, entry: { ...record.entry, [field]: bytes } }),
        ).toThrow(BuckMaintainProgressError)
    },
  )

  it('rejects unknown versions, acting manifests, extra fields and invalid runtime digests', () => {
    for (const invalid of [
      { ...manifest, version: 2 },
      { ...manifest, dryRun: false },
      { ...manifest, extra: true },
      { ...manifest, runtime: { ...runtime, executableSha256: 'invalid' } },
    ])
      expect(() => decodeManifest(canonicalBuckMaintainJson(invalid))).toThrow()
  })

  it('rejects malformed JSON, unsafe counts, invalid timestamps and nested excess fields', () => {
    expect(() => decodeRecord('{')).toThrow()
    for (const invalid of [
      { ...record, index: Number.MAX_SAFE_INTEGER + 1 },
      { ...record, capture: { ...record.capture, startedAt: -1 } },
      { ...record, entry: { ...record.entry, extra: true } },
      { ...record, entry: { ...record.entry, bytesBefore: -1 } },
    ])
      expect(() => decodeRecord(canonicalBuckMaintainJson(invalid))).toThrow()
  })
})
