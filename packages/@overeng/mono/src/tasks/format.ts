/**
 * Format tasks using oxfmt.
 *
 * Expects `oxfmt.json` config at repo root (auto-discovered).
 * Genie-generated files are excluded via inline patterns.
 */

import { Effect } from 'effect'

import { runCommand } from '../utils.ts'

/** Exclude patterns for genie-generated read-only files */
const genieExcludePatterns = [
  '!**/package.json',
  '!**/tsconfig.json',
  '!**/tsconfig.*.json',
  '!.github/workflows/*.yml',
]

/** Create format check task (oxfmt --check) */
export const formatCheck = runCommand({
  command: 'oxfmt',
  args: ['-c', 'oxfmt.json', '--check', '.', ...genieExcludePatterns],
}).pipe(Effect.withSpan('formatCheck'))

/** Create format fix task (oxfmt) */
export const formatFix = runCommand({
  command: 'oxfmt',
  args: ['-c', 'oxfmt.json', '.', ...genieExcludePatterns],
}).pipe(Effect.withSpan('formatFix'))
