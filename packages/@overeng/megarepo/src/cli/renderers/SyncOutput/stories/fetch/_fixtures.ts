/**
 * Fixtures for `mr fetch` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import { COMMITS, MEMBERS } from '../../../_story-constants.ts'
import type { MemberLockSyncResult } from '../../schema.ts'

// =============================================================================
// Fetch Results
// =============================================================================

/** Fetch results with mixed updates */
export const fetchResults: MemberSyncResult[] = [
  { name: MEMBERS.dotfiles, status: 'synced', ref: 'main' },
  { name: MEMBERS.homepage, status: 'already_synced' },
  {
    name: MEMBERS.devTools,
    status: 'updated',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
    ref: 'main',
  },
  {
    name: MEMBERS.appPlatform,
    status: 'updated',
    commit: COMMITS.appPlatform.current,
    previousCommit: COMMITS.appPlatform.previous,
    ref: 'main',
  },
  { name: MEMBERS.coreLib, status: 'already_synced' },
  { name: MEMBERS.studioOrg, status: 'synced', ref: 'main' },
]

/** Fetch with --create-branches (new branches created) */
export const fetchWithNewBranches: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'cloned', ref: 'feature/new-api' },
  {
    name: MEMBERS.devTools,
    status: 'updated',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
    ref: 'main',
  },
  { name: MEMBERS.appPlatform, status: 'synced', ref: 'feature/new-api' },
  { name: MEMBERS.dotfiles, status: 'already_synced' },
]

/** Fetch with errors (network, auth) */
export const fetchWithErrors: MemberSyncResult[] = [
  {
    name: MEMBERS.coreLib,
    status: 'updated',
    commit: COMMITS.coreLib.current,
    previousCommit: COMMITS.coreLib.previous,
    ref: 'main',
  },
  { name: MEMBERS.devTools, status: 'error', message: 'network timeout during fetch' },
  { name: MEMBERS.appPlatform, status: 'already_synced' },
  { name: MEMBERS.studioOrg, status: 'error', message: 'authentication failed' },
]

// =============================================================================
// Fetch Lock Sync Results
// =============================================================================

/** Lock input sync results including source files (flake.nix/devenv.yaml + lock files) */
export const fetchLockInputSyncResults: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.coreLib,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.coreLib,
            memberName: MEMBERS.coreLib,
            oldRev: COMMITS.coreLib.previous,
            newRev: COMMITS.coreLib.current,
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.coreLib,
            memberName: MEMBERS.coreLib,
            oldRev: COMMITS.coreLib.previous,
            newRev: COMMITS.coreLib.current,
          },
        ],
      },
    ],
  },
]

/** Full nix lock sync including source file (flake.nix, devenv.yaml) updates */
export const fetchFullNixSync: MemberLockSyncResult[] = [
  {
    memberName: MEMBERS.dotfiles,
    files: [
      {
        type: 'flake.nix',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
      {
        type: 'flake.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.appPlatform,
            memberName: MEMBERS.appPlatform,
            oldRev: COMMITS.appPlatform.previous,
            newRev: COMMITS.appPlatform.current,
          },
        ],
      },
    ],
  },
  {
    memberName: MEMBERS.studioOrg,
    files: [
      {
        type: 'devenv.yaml',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
      {
        type: 'devenv.lock',
        updatedInputs: [
          {
            _tag: 'RevUpdate',
            inputName: MEMBERS.devTools,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
          {
            _tag: 'RevUpdate',
            inputName: `${MEMBERS.devTools}-browser`,
            memberName: MEMBERS.devTools,
            oldRev: COMMITS.devTools.previous,
            newRev: COMMITS.devTools.current,
          },
        ],
      },
    ],
  },
]
