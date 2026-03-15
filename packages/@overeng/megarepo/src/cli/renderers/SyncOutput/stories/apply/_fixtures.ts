/**
 * Fixtures for `mr apply` stories.
 *
 * @internal
 */

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'

// =============================================================================
// Apply Results
// =============================================================================

/** All members applied from lockfile (typical CI scenario) */
export const applyResults: MemberSyncResult[] = [
  { name: 'core-lib', status: 'applied', commit: 'a1b2c3d4e5' },
  { name: 'dev-tools', status: 'applied', commit: 'f0e1d2c3b4' },
  { name: 'app-platform', status: 'applied', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'applied', commit: '9f8e7d6c5b' },
  { name: 'homepage', status: 'applied', commit: 'deadbeef42' },
]

/** Some members already at correct commit */
export const applyPartial: MemberSyncResult[] = [
  { name: 'core-lib', status: 'applied', commit: 'a1b2c3d4e5' },
  { name: 'dev-tools', status: 'already_synced' },
  { name: 'app-platform', status: 'applied', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'already_synced' },
]

/** Apply failure (lockfile out of date, missing commits) */
export const applyWithErrors: MemberSyncResult[] = [
  { name: 'core-lib', status: 'applied', commit: 'a1b2c3d4e5' },
  {
    name: 'dev-tools',
    status: 'error',
    message: 'commit f0e1d2c not found — run mr fetch',
  },
  { name: 'app-platform', status: 'applied', commit: '1a2b3c4d5e' },
  { name: 'dotfiles', status: 'error', message: 'repository not found' },
]

/** Apply with lock sync results (lock files updated alongside apply) */
export const applyWithLockSync: MemberSyncResult[] = [
  { name: 'core-lib', status: 'applied', commit: 'a1b2c3d4e5' },
  { name: 'dev-tools', status: 'applied', commit: 'f0e1d2c3b4' },
  { name: 'app-platform', status: 'applied', commit: '1a2b3c4d5e' },
]
