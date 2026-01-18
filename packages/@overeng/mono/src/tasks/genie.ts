/**
 * Genie tasks for config file generation and coverage checking.
 */

import { FileSystem, Path } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect } from 'effect'

import { GenieCoverageError } from '../errors.ts'
import { runCommand } from '../utils.ts'
import type { GenieCoverageConfig } from './types.ts'

/** Find config files that are missing corresponding .genie.ts sources */
const findMissingGenieSources = Effect.fn('findMissingGenieSources')(function* (
  config: GenieCoverageConfig,
) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

  const patterns = new Set(config.patterns ?? ['package.json', 'tsconfig.json'])
  const skipDirs = new Set(config.skipDirs)

  const walk: (dir: string) => Effect.Effect<string[], PlatformError, never> = Effect.fnUntraced(
    function* (dir) {
      const exists = yield* fs.exists(dir)
      if (!exists) return []

      const entries = yield* fs.readDirectory(dir)
      const results: string[] = []

      for (const entry of entries) {
        if (skipDirs.has(entry)) continue

        const fullPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(fullPath)

        if (stat.type === 'Directory') {
          const nested = yield* walk(fullPath)
          results.push(...nested)
        } else if (patterns.has(entry)) {
          const genieSourcePath = `${fullPath}.genie.ts`
          const hasGenieSource = yield* fs.exists(genieSourcePath)
          if (!hasGenieSource) {
            results.push(pathService.relative(cwd, fullPath))
          }
        }
      }

      return results
    },
  )

  const allMissing: string[] = []
  for (const scanDir of config.scanDirs) {
    const missing = yield* walk(pathService.join(cwd, scanDir))
    allMissing.push(...missing)
  }

  return allMissing.toSorted()
})

/** Check that all config files have genie sources, fail if any are missing */
export const checkGenieCoverage = Effect.fn('checkGenieCoverage')(function* (
  config: GenieCoverageConfig,
) {
  const missing = yield* findMissingGenieSources(config)
  if (missing.length > 0) {
    return yield* new GenieCoverageError({ missingGenieSources: missing })
  }
})

/** Genie check task (verifies generated files are up to date) */
export const genieCheck = runCommand({
  command: 'genie',
  args: ['--check'],
}).pipe(Effect.withSpan('genieCheck'))
