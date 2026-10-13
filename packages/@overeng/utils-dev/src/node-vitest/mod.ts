// oxlint-disable-next-line import/no-unassigned-import -- side-effect-only module: forces `process.stdout.isTTY` for consistent test output
import './global.ts'
import * as EffectVitest from '@effect/vitest'

import * as EnhancedVitest from './Vitest.ts'

const repositoryEnvironmentKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
] as const

/**
 * Give a temporary repository its own Git location and index, even inside a hook.
 * Preserve other child-process inputs without mutating the caller's environment.
 * Pass the result as the complete child environment, not as an inherited overlay.
 */
export const makeTempGitEnvironment = (
  ambient: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv => {
  const isolated = { ...ambient }
  for (const key of repositoryEnvironmentKeys) {
    delete isolated[key]
  }
  return isolated
}

/** @module Composes base @effect/vitest APIs with local testing helpers. */
export const Vitest: typeof EffectVitest & typeof EnhancedVitest = {
  ...EffectVitest,
  ...EnhancedVitest,
}
