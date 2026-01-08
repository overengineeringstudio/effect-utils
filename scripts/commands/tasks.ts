import { FileSystem, Path } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect } from 'effect'

import { GenieCoverageError } from './errors.js'
import { runCommand } from './utils.js'

export const OXC_CONFIG_PATH = 'packages/@overeng/oxc-config'

/** Directories to scan for config files that should have genie sources */
const GENIE_SCAN_DIRS = ['packages', 'scripts', 'context']

/** Config file patterns that should have genie sources */
const GENIE_CONFIG_PATTERNS = new Set(['package.json', 'tsconfig.json'])

/** Directories to skip when scanning for config files */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.direnv', '.devenv', 'tmp'])

/** Find config files that are missing corresponding .genie.ts sources */
const findMissingGenieSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

  const walk = (dir: string): Effect.Effect<string[], PlatformError, never> =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(dir)
      if (!exists) return []

      const entries = yield* fs.readDirectory(dir)
      const results: string[] = []

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue

        const fullPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(fullPath)

        if (stat.type === 'Directory') {
          const nested = yield* walk(fullPath)
          results.push(...nested)
        } else if (GENIE_CONFIG_PATTERNS.has(entry)) {
          const genieSourcePath = `${fullPath}.genie.ts`
          const hasGenieSource = yield* fs.exists(genieSourcePath)
          if (!hasGenieSource) {
            results.push(pathService.relative(cwd, fullPath))
          }
        }
      }

      return results
    })

  const allMissing: string[] = []
  for (const scanDir of GENIE_SCAN_DIRS) {
    const missing = yield* walk(pathService.join(cwd, scanDir))
    allMissing.push(...missing)
  }

  return allMissing.toSorted()
}).pipe(Effect.withSpan('findMissingGenieSources'))

/** Check that all config files have genie sources, fail if any are missing */
export const checkGenieCoverage = Effect.gen(function* () {
  const missing = yield* findMissingGenieSources
  if (missing.length > 0) {
    return yield* new GenieCoverageError({ missingGenieSources: missing })
  }
}).pipe(Effect.withSpan('checkGenieCoverage'))

/** Format check effect (oxfmt --check) */
export const formatCheck = runCommand({
  command: 'oxfmt',
  args: ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, '--check', '.'],
}).pipe(Effect.withSpan('formatCheck'))

/** Format fix effect (oxfmt) */
export const formatFix = runCommand({
  command: 'oxfmt',
  args: ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, '.'],
}).pipe(Effect.withSpan('formatFix'))

/** Lint check effect (oxlint) */
export const lintCheck = runCommand({
  command: 'oxlint',
  args: ['-c', `${OXC_CONFIG_PATH}/lint.jsonc`, '--import-plugin', '--deny-warnings'],
}).pipe(Effect.withSpan('lintCheck'))

/** Lint fix effect (oxlint --fix) */
export const lintFix = runCommand({
  command: 'oxlint',
  args: ['-c', `${OXC_CONFIG_PATH}/lint.jsonc`, '--import-plugin', '--deny-warnings', '--fix'],
}).pipe(Effect.withSpan('lintFix'))

/** Type check effect */
export const typeCheck = runCommand({
  command: 'tsc',
  args: ['--build', 'tsconfig.all.json'],
}).pipe(Effect.withSpan('typeCheck'))

/** Genie check effect (verifies generated files are up to date) */
export const genieCheck = runCommand({
  command: 'mono',
  args: ['genie', '--check'],
}).pipe(Effect.withSpan('genieCheck'))

/** Test effect */
export const testRun = runCommand({
  command: 'vitest',
  args: ['run'],
}).pipe(Effect.withSpan('testRun'))

/** Combined lint check: format + lint + genie coverage */
export const allLintChecks = Effect.all([formatCheck, lintCheck, checkGenieCoverage], {
  concurrency: 'unbounded',
}).pipe(Effect.withSpan('allLintChecks'))

/** Combined lint fix: format + lint */
export const allLintFixes = Effect.all([formatFix, lintFix], {
  concurrency: 'unbounded',
}).pipe(Effect.withSpan('allLintFixes'))
