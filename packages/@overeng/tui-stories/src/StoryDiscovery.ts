/**
 * Discover .stories.tsx files and dynamically import them.
 *
 * Uses glob patterns to find story files in package directories,
 * then loads them via dynamic import() to extract CSF exports.
 */

import { globSync } from 'node:fs'
import { resolve } from 'node:path'

import { Context, Effect, Array as Arr } from 'effect'

import {
  parseStoryModule,
  type ParsedStoryModule,
  type RawStoryModuleExports,
} from './StoryModule.ts'

// =============================================================================
// Service
// =============================================================================

/** Error raised when story file discovery or import fails */
export class StoryDiscoveryError extends Error {
  readonly _tag = 'StoryDiscoveryError'
}

/** Default glob patterns for story files */
const DEFAULT_PATTERNS = ['src/**/*.stories.tsx'] as const

/** Resolve glob patterns to absolute file paths within a directory */
const globFiles = ({
  dir,
  patterns,
}: {
  readonly dir: string
  readonly patterns: readonly string[]
}): string[] => {
  const results: string[] = []
  const absDir = resolve(dir)
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: absDir })
    for (const match of matches) {
      results.push(resolve(absDir, match))
    }
  }
  return Arr.dedupe(results).toSorted()
}

/** Dynamically import a single story file and parse it (skips on import failure) */
const importStoryFile = (filePath: string): Effect.Effect<ParsedStoryModule | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require)
      const moduleExports = (await import(filePath)) as RawStoryModuleExports
      return parseStoryModule({ exports: moduleExports, filePath })
    },
    catch: (error) =>
      new StoryDiscoveryError(
        `Failed to import ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(`Skipping ${filePath}: ${error.message}`)),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

/** Result of story discovery including skip statistics */
export interface DiscoverStoriesResult {
  readonly modules: readonly ParsedStoryModule[]
  readonly skippedCount: number
}

type StoryImportConcurrency = 1 | 'unbounded'

const bunVersionSupportsConcurrentDynamicImport = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) === true ? 0 : part))

  return major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 14)))
}

/** Return safe story import concurrency for the active JavaScript runtime. */
export const storyImportConcurrencyForRuntime = (
  bunVersion: string | undefined = process.versions.bun,
): StoryImportConcurrency => {
  if (bunVersion === undefined) return 'unbounded'

  // Fixed by Bun's module-loader rewrite in 1.3.14:
  // https://github.com/oven-sh/bun/issues/20489
  return bunVersionSupportsConcurrentDynamicImport(bunVersion) === true ? 'unbounded' : 1
}

/** Discover and parse all story files in the given package directories */
export const discoverStories = (options: {
  readonly packageDirs: readonly string[]
  readonly patterns?: readonly string[]
}): Effect.Effect<DiscoverStoriesResult> =>
  Effect.gen(function* () {
    const patterns = options.patterns ?? DEFAULT_PATTERNS

    const filePaths = options.packageDirs.flatMap((dir) => globFiles({ dir, patterns }))

    if (filePaths.length === 0) {
      return { modules: [], skippedCount: 0 }
    }

    const results = yield* Effect.all(
      filePaths.map((fp) => importStoryFile(fp)),
      { concurrency: storyImportConcurrencyForRuntime() },
    )

    const modules = results.filter((m): m is ParsedStoryModule => m !== undefined)
    const skippedCount = results.length - modules.length

    return { modules, skippedCount }
  })

// =============================================================================
// Effect Service (for dependency injection in tests)
// =============================================================================

/** Effect service for story discovery (enables dependency injection in tests) */
export class StoryDiscovery extends Context.Tag('StoryDiscovery')<
  StoryDiscovery,
  {
    readonly discover: (options: {
      readonly packageDirs: readonly string[]
      readonly patterns?: readonly string[]
    }) => Effect.Effect<DiscoverStoriesResult>
  }
>() {
  static readonly live = StoryDiscovery.of({
    discover: discoverStories,
  })
}
