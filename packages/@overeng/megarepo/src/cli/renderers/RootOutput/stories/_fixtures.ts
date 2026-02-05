/**
 * Shared fixtures for RootOutput stories.
 *
 * @internal
 */

import type { RootStateType } from '../mod.ts'

// =============================================================================
// Success States
// =============================================================================

export const successState: RootStateType = {
  _tag: 'Success',
  root: '/Users/dev/megarepo/',
  name: 'my-workspace',
  source: 'search',
}

// =============================================================================
// Error States
// =============================================================================

export const notFoundState: RootStateType = {
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found in current directory or any parent.',
}

export const invalidCwdState: RootStateType = {
  _tag: 'Error',
  error: 'invalid_cwd',
  message: '--cwd directory does not exist: /nonexistent/path/',
}

export const invalidCwdNotDirState: RootStateType = {
  _tag: 'Error',
  error: 'invalid_cwd',
  message: '--cwd path is not a directory: /Users/dev/some-file.txt',
}
