/**
 * Lint tasks using oxlint.
 */

import type { PlatformError } from '@effect/platform/Error'
import { Effect, Exit, Option } from 'effect'

import { type CommandError, GenieCoverageError } from '../errors.ts'
import { runCommand } from '../utils.ts'
import { formatCheck } from './format.ts'
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
export const allLintChecks = ({
  oxcConfig,
  genieConfig,
}: {
  oxcConfig: OxcConfig
  genieConfig: GenieCoverageConfig
}) =>
  Effect.all(
    [
      formatCheck(oxcConfig).pipe(Effect.exit),
      lintCheck(oxcConfig).pipe(Effect.exit),
      checkGenieCoverage(genieConfig).pipe(Effect.exit),
    ],
    {
      concurrency: 'unbounded',
    },
  ).pipe(
    Effect.flatMap((exits) => {
      const unifiedExits = exits as ReadonlyArray<
        Exit.Exit<void | undefined, CommandError | GenieCoverageError | PlatformError>
      >

      return Option.match(Exit.all(unifiedExits, { parallel: true }), {
        onNone: () => Effect.void,
        onSome: (exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause)),
      })
    }),
    Effect.withSpan('allLintChecks'),
  )

/** Create combined lint fixes: format + lint */
export const allLintFixes = (oxcConfig: OxcConfig) =>
  Effect.all([formatFix(oxcConfig), lintFix(oxcConfig)], {
    concurrency: 'unbounded',
  }).pipe(Effect.withSpan('allLintFixes'))
