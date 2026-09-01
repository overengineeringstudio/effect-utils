import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  OWNED_WORKTREE_ACQUISITION_VERSION,
  OwnedWorktreeAcquisitionJournal,
  OwnedWorktreeAcquisitionLockOwner,
  OwnedWorktreeAcquisitionState,
  OwnedWorktreeName,
} from './owned-worktree-acquisition-schema.ts'

const decodeName = Schema.decodeUnknownSync(OwnedWorktreeName)
const decodeState = Schema.decodeUnknownSync(OwnedWorktreeAcquisitionState)
const decodeLockOwner = Schema.decodeUnknownSync(OwnedWorktreeAcquisitionLockOwner, {
  errors: 'all',
  onExcessProperty: 'error',
})
const decodeJournal = Schema.decodeUnknownSync(OwnedWorktreeAcquisitionJournal, {
  errors: 'all',
  onExcessProperty: 'error',
})

describe('OwnedWorktreeAcquisition schema', () => {
  it('accepts every closed journal state', () => {
    expect(
      ['prepared', 'moved_to_temp', 'root_created', 'installed', 'generated', 'complete'].map(
        (state) => decodeState(state),
      ),
    ).toEqual(['prepared', 'moved_to_temp', 'root_created', 'installed', 'generated', 'complete'])
    expect(() => decodeState('unknown')).toThrow()
  })

  it('accepts only canonical one-segment owned member names', () => {
    expect(decodeName('effect-utils')).toBe('effect-utils')
    for (const invalid of ['', '.', '..', '../owner', 'repos/owner', 'owner\\nested', '-owner']) {
      expect(() => decodeName(invalid), invalid).toThrow()
    }
  })

  it('strictly validates durable lock owner pid and exact token', () => {
    const owner = {
      nonce: 'a'.repeat(32),
      pid: 42,
      version: OWNED_WORKTREE_ACQUISITION_VERSION,
    }
    expect(decodeLockOwner(owner)).toEqual(owner)
    expect(() => decodeLockOwner({ ...owner, nonce: 'short' })).toThrow()
    expect(() => decodeLockOwner({ ...owner, pid: 0 })).toThrow()
    expect(() => decodeLockOwner({ ...owner, extra: true })).toThrow()
  })

  it('strictly validates journal identity and canonical paths', () => {
    const journal = {
      adminDir: '/store/repo.git/worktrees/workspace',
      bareRepo: '/store/repo.git',
      branchRef: 'refs/heads/main',
      head: '0123456789abcdef0123456789abcdef01234567',
      ownedMember: 'owner',
      state: 'prepared',
      statusPorcelainBase64: 'TSA=',
      tempPath: '/store/.workspace.owned-worktree-acquisition-temp',
      version: OWNED_WORKTREE_ACQUISITION_VERSION,
      workspaceRoot: '/store/workspace',
    } as const
    expect(decodeJournal(journal)).toEqual(journal)
    expect(() => decodeJournal({ ...journal, unexpected: true })).toThrow()
    expect(() => decodeJournal({ ...journal, workspaceRoot: '/store/../workspace' })).toThrow()
    expect(() => decodeJournal({ ...journal, statusPorcelainBase64: 'not-base64' })).toThrow()
  })
})
