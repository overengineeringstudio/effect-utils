import { FileSystem, Path } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect, Exit, Option } from 'effect'

import { CommandError, GenieCoverageError } from './errors.ts'
import { runCommand } from './utils.ts'

// =============================================================================
// Task Configuration Types
// =============================================================================

/** Configuration for oxc-based format/lint tasks */
export interface OxcConfig {
  /** Path to the oxc config directory (containing fmt.jsonc and lint.jsonc) */
  configPath: string
  /** Additional oxlint args (e.g. --report-unused-disable-directives) */
  extraLintArgs?: string[]
}

/** Configuration for genie coverage checking */
export interface GenieCoverageConfig {
  /** Directories to scan for config files (e.g. ['apps', 'packages', 'scripts']) */
  scanDirs: string[]
  /** Directories to skip when scanning (e.g. ['node_modules', 'dist', '.git']) */
  skipDirs: string[]
  /** Config file patterns to check (defaults to ['package.json', 'tsconfig.json']) */
  patterns?: string[]
}

/** Configuration for TypeScript checking */
export interface TypeCheckConfig {
  /** Path to tsconfig for project references build (e.g. 'tsconfig.all.json') */
  tsconfigPath?: string
}

/** Configuration for test running */
export interface TestConfig {
  /** Test runner command (defaults to 'vitest') */
  command?: string
  /** Additional args for the test runner */
  args?: string[]
}

/** Configuration for install task */
export interface InstallConfig {
  /** Directories to scan for package.json files (e.g. ['packages', 'scripts', 'apps']) */
  scanDirs: string[]
  /** Directories to skip when scanning (e.g. ['node_modules', '.git']) */
  skipDirs?: string[]
}

// =============================================================================
// Format Tasks
// =============================================================================

/** Create format check task (oxfmt --check) */
export const formatCheck = (config: OxcConfig) =>
  runCommand({
    command: 'oxfmt',
    args: ['-c', `${config.configPath}/fmt.jsonc`, '--check', '.'],
  }).pipe(Effect.withSpan('formatCheck'))

/** Create format fix task (oxfmt) */
export const formatFix = (config: OxcConfig) =>
  runCommand({
    command: 'oxfmt',
    args: ['-c', `${config.configPath}/fmt.jsonc`, '.'],
  }).pipe(Effect.withSpan('formatFix'))

// =============================================================================
// Lint Tasks
// =============================================================================

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

// =============================================================================
// Genie Tasks
// =============================================================================

/** Find config files that are missing corresponding .genie.ts sources */
const findMissingGenieSources = (config: GenieCoverageConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

    const patterns = new Set(config.patterns ?? ['package.json', 'tsconfig.json'])
    const skipDirs = new Set(config.skipDirs)

    const walk = (dir: string): Effect.Effect<string[], PlatformError, never> =>
      Effect.gen(function* () {
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
      })

    const allMissing: string[] = []
    for (const scanDir of config.scanDirs) {
      const missing = yield* walk(pathService.join(cwd, scanDir))
      allMissing.push(...missing)
    }

    return allMissing.toSorted()
  }).pipe(Effect.withSpan('findMissingGenieSources'))

/** Check that all config files have genie sources, fail if any are missing */
export const checkGenieCoverage = (config: GenieCoverageConfig) =>
  Effect.gen(function* () {
    const missing = yield* findMissingGenieSources(config)
    if (missing.length > 0) {
      return yield* new GenieCoverageError({ missingGenieSources: missing })
    }
  }).pipe(Effect.withSpan('checkGenieCoverage'))

/** Genie check task (verifies generated files are up to date) */
export const genieCheck = runCommand({
  command: 'genie',
  args: ['--check'],
}).pipe(Effect.withSpan('genieCheck'))

// =============================================================================
// TypeScript Tasks
// =============================================================================

/** Type check task */
export const typeCheck = (config?: TypeCheckConfig) =>
  runCommand({
    command: 'tsc',
    args: ['--build', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheck'))

/** Type check in watch mode */
export const typeCheckWatch = (config?: TypeCheckConfig) =>
  runCommand({
    command: 'tsc',
    args: ['--build', '--watch', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheckWatch'))

/** Clean TypeScript build artifacts */
export const typeCheckClean = (config?: TypeCheckConfig) =>
  runCommand({
    command: 'tsc',
    args: ['--build', '--clean', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheckClean'))

// =============================================================================
// Test Tasks
// =============================================================================

/** Run tests */
export const testRun = (config?: TestConfig) =>
  runCommand({
    command: config?.command ?? 'vitest',
    args: ['run', ...(config?.args ?? [])],
  }).pipe(Effect.withSpan('testRun'))

/** Run tests in watch mode */
export const testWatch = (config?: TestConfig) =>
  runCommand({
    command: config?.command ?? 'vitest',
    args: [...(config?.args ?? [])],
  }).pipe(Effect.withSpan('testWatch'))

// =============================================================================
// Build Tasks
// =============================================================================

/** Build task (tsc --build) */
export const build = (config?: TypeCheckConfig) =>
  runCommand({
    command: 'tsc',
    args: ['--build', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('build'))

// =============================================================================
// Install Tasks
// =============================================================================

/** Default directories to skip when scanning for packages */
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.devenv', '.direnv'])

/** Find all directories containing package.json files */
export const findPackageDirs = (config: InstallConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()
    const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])])

    const walk = (dir: string): Effect.Effect<string[], PlatformError, never> =>
      Effect.gen(function* () {
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
          } else if (entry === 'package.json') {
            results.push(dir)
          }
        }

        return results
      })

    const allDirs: string[] = []
    for (const scanDir of config.scanDirs) {
      const dirs = yield* walk(pathService.join(cwd, scanDir))
      allDirs.push(...dirs)
    }

    return allDirs.toSorted()
  }).pipe(Effect.withSpan('findPackageDirs'))

/** Install dependencies for a single package directory */
export const installPackage = (
  dir: string,
  options?: { frozenLockfile?: boolean },
) =>
  runCommand({
    command: 'bun',
    args: ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])],
    cwd: dir,
  }).pipe(Effect.withSpan('installPackage', { attributes: { dir } }))

/** Install dependencies for all packages in parallel */
export const installAll = (
  config: InstallConfig,
  options?: { frozenLockfile?: boolean },
) =>
  Effect.gen(function* () {
    const dirs = yield* findPackageDirs(config)

    yield* Effect.all(
      dirs.map((dir) => installPackage(dir, options)),
      { concurrency: 'unbounded' },
    )

    return dirs
  }).pipe(Effect.withSpan('installAll'))

// =============================================================================
// Composite Tasks
// =============================================================================

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
