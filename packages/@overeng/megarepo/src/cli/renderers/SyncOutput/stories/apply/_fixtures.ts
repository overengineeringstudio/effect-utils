/**
 * Fixtures for `mr apply` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import { COMMITS, MEMBERS } from '../../../_story-constants.ts'

// =============================================================================
// Apply Results
// =============================================================================

/** All members applied from lockfile (typical CI scenario) */
export const applyResults: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'applied', commit: COMMITS.coreLib.current },
  { name: MEMBERS.devTools, status: 'applied', commit: COMMITS.devTools.current },
  { name: MEMBERS.appPlatform, status: 'applied', commit: COMMITS.appPlatform.current },
  { name: MEMBERS.dotfiles, status: 'applied', commit: COMMITS.dotfiles.current },
  { name: MEMBERS.homepage, status: 'applied', commit: COMMITS.homepage.current },
]

/** Some members already at correct commit */
export const applyPartial: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'applied', commit: COMMITS.coreLib.current },
  { name: MEMBERS.devTools, status: 'already_synced' },
  { name: MEMBERS.appPlatform, status: 'applied', commit: COMMITS.appPlatform.current },
  { name: MEMBERS.dotfiles, status: 'already_synced' },
]

/** Apply failure (lockfile out of date, missing commits) */
export const applyWithErrors: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'applied', commit: COMMITS.coreLib.current },
  {
    name: MEMBERS.devTools,
    status: 'error',
    message: `commit ${COMMITS.devTools.current.slice(0, 7)} not found — run mr fetch`,
  },
  { name: MEMBERS.appPlatform, status: 'applied', commit: COMMITS.appPlatform.current },
  { name: MEMBERS.dotfiles, status: 'error', message: 'repository not found' },
]

/** Apply with lock sync results (lock files updated alongside apply) */
export const applyWithLockSync: MemberSyncResult[] = [
  { name: MEMBERS.coreLib, status: 'applied', commit: COMMITS.coreLib.current },
  { name: MEMBERS.devTools, status: 'applied', commit: COMMITS.devTools.current },
  { name: MEMBERS.appPlatform, status: 'applied', commit: COMMITS.appPlatform.current },
]

/** Apply with a pinned member (core-lib) — used with applyForceFlag */
export const applyWithPinned: MemberSyncResult[] = [
  {
    name: MEMBERS.coreLib,
    status: 'applied',
    commit: COMMITS.coreLib.current,
    previousCommit: COMMITS.coreLib.previous,
  },
  {
    name: MEMBERS.devTools,
    status: 'applied',
    commit: COMMITS.devTools.current,
    previousCommit: COMMITS.devTools.previous,
  },
  { name: MEMBERS.appPlatform, status: 'already_synced' },
  {
    name: MEMBERS.dotfiles,
    status: 'applied',
    commit: COMMITS.dotfiles.current,
    previousCommit: COMMITS.dotfiles.previous,
  },
]
