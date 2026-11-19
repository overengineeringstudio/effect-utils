import { describe, expect, it } from 'vitest'

import {
  canonicalBuckMaintainJson,
  validateBuckMaintainProgressOptions,
} from './store-buck-maintain-progress-store.ts'

describe('Buck maintenance checkpoint options', () => {
  it('preserves stateless acting and report-only calls', () => {
    for (const dryRun of [false, true]) expect(validateBuckMaintainProgressOptions({ dryRun, progressDir: undefined, maxWorktrees: undefined })).toBeUndefined()
  })

  it.each([
    { dryRun: false, progressDir: '/progress', maxWorktrees: undefined },
    { dryRun: true, progressDir: undefined, maxWorktrees: 1 },
    { dryRun: true, progressDir: '', maxWorktrees: 1 },
    { dryRun: true, progressDir: ' ', maxWorktrees: 1 },
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map((maxWorktrees) => ({ dryRun: true, progressDir: '/progress', maxWorktrees })),
  ])('fails closed for invalid options: %j', (options) => {
    expect(validateBuckMaintainProgressOptions(options)?._tag).toBe('BuckMaintainProgressError')
  })

  it('accepts a bounded explicit dry run', () => {
    expect(validateBuckMaintainProgressOptions({ dryRun: true, progressDir: '/progress', maxWorktrees: 2 })).toBeUndefined()
  })

  it('canonicalizes object keys recursively, omits absent fields, and retains array order', () => {
    expect(canonicalBuckMaintainJson({ z: undefined, b: { z: 2, a: 1 }, a: [2, 1] }))
      .toBe(canonicalBuckMaintainJson({ a: [2, 1], b: { a: 1, z: 2 } }))
    expect(canonicalBuckMaintainJson({ a: [2, 1] })).not.toBe(canonicalBuckMaintainJson({ a: [1, 2] }))
  })
})
