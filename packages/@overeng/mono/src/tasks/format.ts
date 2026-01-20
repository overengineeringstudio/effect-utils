/**
 * Format tasks using oxfmt.
 */

import { Effect } from 'effect'

import { runCommand } from '../utils.ts'
import type { OxcConfig } from './types.ts'

/** Exclude patterns for oxfmt (genie-generated read-only files) */
const oxfmtExcludePatterns = [
  '!**/package.json',
  '!**/tsconfig.json',
  '!**/tsconfig.*.json',
  '!.github/workflows/*.yml',
  '!packages/@overeng/oxc-config/*.jsonc',
]

/** Create format check task (oxfmt --check) */
export const formatCheck = (config: OxcConfig) =>
  runCommand({
    command: 'oxfmt',
    args: ['-c', `${config.configPath}/fmt.jsonc`, '--check', '.', ...oxfmtExcludePatterns],
  }).pipe(Effect.withSpan('formatCheck'))

/** Create format fix task (oxfmt) */
export const formatFix = (config: OxcConfig) =>
  runCommand({
    command: 'oxfmt',
    args: ['-c', `${config.configPath}/fmt.jsonc`, '.', ...oxfmtExcludePatterns],
  }).pipe(Effect.withSpan('formatFix'))
