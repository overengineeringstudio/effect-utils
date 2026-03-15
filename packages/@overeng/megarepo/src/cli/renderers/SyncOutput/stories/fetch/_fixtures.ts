/**
 * Fixtures for `mr fetch` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import type { MemberLockSyncResult } from '../../schema.ts'

// =============================================================================
// Fetch Results
// =============================================================================

/** Fetch results with mixed updates */
export const fetchResults: MemberSyncResult[] = [
  { name: 'dotfiles', status: 'synced', ref: 'main' },
  { name: 'homepage', status: 'already_synced' },
  {
    name: 'dev-tools',
    status: 'updated',
    commit: 'def5678abc',
    previousCommit: 'fedcba987',
    ref: 'main',
  },
  {
    name: 'app-platform',
    status: 'updated',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
    ref: 'main',
  },
  { name: 'core-lib', status: 'already_synced' },
  { name: 'studio-org', status: 'synced', ref: 'main' },
]

/** Fetch with --create-branches (new branches created) */
export const fetchWithNewBranches: MemberSyncResult[] = [
  { name: 'core-lib', status: 'cloned', ref: 'feature/new-api' },
  {
    name: 'dev-tools',
    status: 'updated',
    commit: 'def5678abc',
    previousCommit: 'fedcba987',
    ref: 'main',
  },
  { name: 'app-platform', status: 'synced', ref: 'feature/new-api' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Fetch with errors (network, auth) */
export const fetchWithErrors: MemberSyncResult[] = [
  {
    name: 'core-lib',
    status: 'updated',
    commit: 'abc1234def',
    previousCommit: '9876543fed',
    ref: 'main',
  },
  { name: 'dev-tools', status: 'error', message: 'network timeout during fetch' },
  { name: 'app-platform', status: 'already_synced' },
  { name: 'private-repo', status: 'error', message: 'authentication failed' },
]

// =============================================================================
// Fetch Lock Sync Results
// =============================================================================

/** Lock input sync results (flake.lock/devenv.lock updates) */
export const fetchLockSyncResults: MemberLockSyncResult[] = [
  {
    memberName: 'core-lib',
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'app-platform',
            memberName: 'app-platform',
            oldRev: '1234567',
            newRev: '7654321',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'core-lib',
            memberName: 'core-lib',
            oldRev: 'fff0000',
            newRev: 'aaa1111',
          },
        ],
      },
    ],
  },
]

/** Full nix lock sync including source file (flake.nix, devenv.yaml) updates */
export const fetchFullNixSync: MemberLockSyncResult[] = [
  {
    memberName: 'dotfiles',
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'app-platform',
            memberName: 'app-platform',
            oldRev: '1111111',
            newRev: '2222222',
          },
        ],
      },
    ],
  },
  {
    memberName: 'studio-org',
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
          {
            _tag: 'RevUpdate',
            inputName: 'dev-tools-browser',
            memberName: 'dev-tools',
            oldRev: 'abc1234',
            newRev: 'def5678',
          },
        ],
      },
    ],
  },
]
