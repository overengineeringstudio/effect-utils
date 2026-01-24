/**
 * Format tasks using oxfmt.
 *
 * Uses default config file (.oxfmtrc.json) with ignorePatterns defined there.
 */

import { Effect } from 'effect'

import { runCommand } from '../utils.ts'

/** Create format check task (oxfmt --check) */
export const formatCheck = () =>
  runCommand({
    command: 'oxfmt',
    args: ['--check', '.'],
  }).pipe(Effect.withSpan('formatCheck'))

/** Create format fix task (oxfmt) */
export const formatFix = () =>
  runCommand({
    command: 'oxfmt',
    args: ['.'],
  }).pipe(Effect.withSpan('formatFix'))
