import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  WORKSPACE_UPDATE_LOCK_SCHEMA,
  WorkspaceUpdateLockOwnerSchema,
  WorkspaceUpdateLockTokenSchema,
} from './workspace-update-lock-schema.ts'

const strict = { errors: 'all', onExcessProperty: 'error' } as const
const decodeOwner = Schema.decodeUnknownSync(WorkspaceUpdateLockOwnerSchema, strict)
const decodeToken = Schema.decodeUnknownSync(WorkspaceUpdateLockTokenSchema, strict)

describe('WorkspaceUpdateLock schema', () => {
  it('accepts only an exact lowercase 128-bit token', () => {
    expect(decodeToken('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef')
    for (const token of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32)]) {
      expect(() => decodeToken(token), token).toThrow()
    }
  })

  it('strictly accepts only schema, token, and a positive pid', () => {
    const owner = {
      schema: WORKSPACE_UPDATE_LOCK_SCHEMA,
      token: 'a'.repeat(32),
      pid: 42,
    } as const
    expect(decodeOwner(owner)).toEqual(owner)
    expect(() => decodeOwner({ ...owner, schema: 2 })).toThrow()
    expect(() => decodeOwner({ ...owner, pid: 0 })).toThrow()
    expect(() => decodeOwner({ ...owner, owner: 'extra' })).toThrow()
  })
})
