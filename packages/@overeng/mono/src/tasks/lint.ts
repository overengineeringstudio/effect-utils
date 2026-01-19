/**
 * Lint tasks using oxlint.
 *
 * Expects `oxlint.json` config at repo root (auto-discovered).
 */

import { Effect, Exit } from 'effect'

import { runCommand } from '../utils.ts'
import { formatCheck, formatFix } from './format.ts'
import { checkGenieCoverage } from './genie.ts'
import type { GenieCoverageConfig } from './types.ts'

/** Create lint check task (oxlint) */
export const lintCheck = runCommand({
  command: 'oxlint',
  args: ['-c', 'oxlint.json', '--import-plugin', '--deny-warnings'],
}).pipe(Effect.withSpan('lintCheck'))

/** Create lint fix task (oxlint --fix) */
export const lintFix = runCommand({
  command: 'oxlint',
  args: ['-c', 'oxlint.json', '--import-plugin', '--deny-warnings', '--fix'],
}).pipe(Effect.withSpan('lintFix'))

/** Create combined lint checks: format + lint + genie coverage */
export const allLintChecks = Effect.fn('allLintChecks')(function* (genieConfig: GenieCoverageConfig) {
  const [formatExit, lintExit, genieExit] = yield* Effect.all(
    [
      formatCheck.pipe(Effect.asVoid, Effect.exit),
      lintCheck.pipe(Effect.asVoid, Effect.exit),
      checkGenieCoverage(genieConfig).pipe(Effect.asVoid, Effect.exit),
    ],
    { concurrency: 'unbounded' },
  )

  // Re-raise any failures
  if (!Exit.isSuccess(formatExit)) return yield* formatExit
  if (!Exit.isSuccess(lintExit)) return yield* lintExit
  if (!Exit.isSuccess(genieExit)) return yield* genieExit
})

/** Create combined lint fixes: format + lint */
export const allLintFixes = Effect.all([formatFix, lintFix], {
  concurrency: 'unbounded',
}).pipe(Effect.withSpan('allLintFixes'))
