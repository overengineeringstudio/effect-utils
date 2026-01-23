/**
 * Lint tasks using oxlint.
 */

import { Effect, Exit } from 'effect'

import { runCommand } from '../utils.ts'
import { formatCheck, formatFix } from './format.ts'
import { checkGenieCoverage } from './genie.ts'
import type { GenieCoverageConfig, OxcConfig } from './types.ts'

/** Create lint check task (oxlint) */
export const lintCheck = (config: OxcConfig) =>
  runCommand({
    command: 'oxlint',
    args: [
      '-c',
      `${config.configPath}/lint.jsonc`,
      '--import-plugin',
      '--deny-warnings',
      ...(config.extraLintArgs ?? []),
    ],
  }).pipe(Effect.withSpan('lintCheck'))

/** Create lint fix task (oxlint --fix) */
export const lintFix = (config: OxcConfig) =>
  runCommand({
    command: 'oxlint',
    args: [
      '-c',
      `${config.configPath}/lint.jsonc`,
      '--import-plugin',
      '--deny-warnings',
      ...(config.extraLintArgs ?? []),
      '--fix',
    ],
  }).pipe(Effect.withSpan('lintFix'))

/** Create combined lint checks: format + lint + genie coverage */
export const allLintChecks = Effect.fn('allLintChecks')(function* ({
  oxcConfig,
  genieConfig,
}: {
  oxcConfig: OxcConfig
  genieConfig: GenieCoverageConfig
}) {
  const [formatExit, lintExit, genieExit] = yield* Effect.all(
    [
      formatCheck(oxcConfig).pipe(Effect.asVoid, Effect.exit),
      lintCheck(oxcConfig).pipe(Effect.asVoid, Effect.exit),
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
export const allLintFixes = (oxcConfig: OxcConfig) =>
  Effect.all([formatFix(oxcConfig), lintFix(oxcConfig)], {
    concurrency: 'unbounded',
  }).pipe(Effect.withSpan('allLintFixes'))
