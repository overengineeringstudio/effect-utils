import { FileSystem, Path } from '@effect/platform'
import * as Command from '@effect/platform/Command'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import { Array, Effect, Exit, Logger, LogLevel, Option, Stream } from 'effect'

import { CommandError, GenieCoverageError } from './errors.ts'
import { task } from './task-system/api.ts'
import { runTaskGraph, runTaskGraphOrFail } from './task-system/graph.ts'
import { ciRenderer } from './task-system/renderers/ci.ts'
import { inlineRenderer } from './task-system/renderers/inline.ts'
import { IS_CI, runCommand } from './utils.ts'

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

/**
 * Resolve the local tsc path from mono's node_modules.
 * This ensures we use the patched TypeScript with Effect Language Service support.
 */
const resolveLocalTsc = (): string => {
  const tscUrl = import.meta.resolve('typescript/bin/tsc')
  return tscUrl.replace('file://', '')
}

/** Type check task */
export const typeCheck = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
    args: ['--build', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheck'))

/** Type check in watch mode */
export const typeCheckWatch = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
    args: ['--build', '--watch', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheckWatch'))

/** Clean TypeScript build artifacts */
export const typeCheckClean = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
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

/** Remove node_modules directories for all packages that will be installed */
export const cleanNodeModules = (config: InstallConfig) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path
    const dirs = yield* findPackageDirs(config)

    yield* Effect.forEach(
      dirs,
      (dir) => {
        const nodeModulesPath = pathService.join(dir, 'node_modules')
        return runCommand({ command: 'rm', args: ['-rf', nodeModulesPath] })
      },
      { concurrency: 'unbounded' },
    )

    return dirs.length
  }).pipe(Effect.withSpan('cleanNodeModules'))

/** Result of installing a package */
export type InstallResult =
  | { _tag: 'success'; dir: string }
  | { _tag: 'failure'; dir: string; error: unknown; stderr?: string; stdout?: string }

/** Install dependencies for a single package directory (captures output, never fails) */
export const installPackageCaptured = ({
  dir,
  options,
}: {
  dir: string
  options?: { frozenLockfile?: boolean }
}): Effect.Effect<InstallResult, never, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const args = ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])]

      const command = Command.make('bun', ...args).pipe(
        Command.workingDirectory(dir),
        Command.stdout('pipe'),
        Command.stderr('pipe'),
      )

      const result = yield* Command.start(command).pipe(
        Effect.flatMap((process) =>
          Effect.all({
            exitCode: process.exitCode,
            stdout: process.stdout.pipe(Stream.decodeText(), Stream.runCollect),
            stderr: process.stderr.pipe(Stream.decodeText(), Stream.runCollect),
          }),
        ),
        Effect.map(({ exitCode, stdout, stderr }) => {
          const stdoutText = Array.fromIterable(stdout).join('')
          const stderrText = Array.fromIterable(stderr).join('')

          if (exitCode === 0) {
            return { _tag: 'success' as const, dir }
          }
          return {
            _tag: 'failure' as const,
            dir,
            error: new Error(`Command failed with exit code ${exitCode}`),
            stdout: stdoutText,
            stderr: stderrText,
          }
        }),
        Effect.catchAll((error) =>
          Effect.succeed({
            _tag: 'failure' as const,
            dir,
            error,
            stderr: String(error),
          }),
        ),
        Effect.withSpan('installPackage', { attributes: { dir } }),
        Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
      )

      return result
    }),
  )

/** Install dependencies for a single package directory */
export const installPackage = ({
  dir,
  options,
}: {
  dir: string
  options?: { frozenLockfile?: boolean }
}) =>
  runCommand({
    command: 'bun',
    args: ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])],
    cwd: dir,
  }).pipe(Effect.withSpan('installPackage', { attributes: { dir } }))

/** Install result with progress tracking */
export type InstallProgress = {
  total: number
  completed: number
  running: number
  results: InstallResult[]
}

/** Install dependencies for all packages in parallel with progress tracking */
export const installAll = ({
  config,
  options,
}: {
  config: InstallConfig
  options?: {
    frozenLockfile?: boolean
    onProgress?: (progress: InstallProgress) => Effect.Effect<void>
  }
}) =>
  Effect.gen(function* () {
    const dirs = yield* findPackageDirs(config)
    const total = dirs.length

    const frozenLockfile = options?.frozenLockfile
    const results = yield* Effect.all(
      dirs.map((dir) =>
        frozenLockfile !== undefined
          ? installPackageCaptured({ dir, options: { frozenLockfile } })
          : installPackageCaptured({ dir }),
      ),
      { concurrency: 'unbounded' },
    )

    return { results, total }
  }).pipe(Effect.withSpan('installAll'))

/** Install dependencies using task system with live progress (task-based implementation) */
export const installAllWithTaskSystem = ({
  config,
  options,
}: {
  config: InstallConfig
  options?: { frozenLockfile?: boolean }
}) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path
    const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

    const dirs = yield* findPackageDirs(config)
    const total = dirs.length

    if (total === 0) {
      return { results: [], total: 0 }
    }

    // Create task for each package directory
    const tasks = dirs.map((dir) => {
      const relativePath = pathService.relative(cwd, dir)
      const taskId = relativePath.replace(/\//g, ':') // Convert path to valid task ID

      return task({
        id: taskId,
        name: `Install ${relativePath}`,
        command: {
          cmd: 'bun',
          args: ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])],
          cwd: dir,
        },
      })
    })

    // Run with inline renderer
    const renderer = inlineRenderer()
    const result = yield* runTaskGraph({
      tasks,
      options: {
        onStateChange: (state) => renderer.render(state),
      },
    })

    yield* renderer.renderFinal(result.state)

    // Convert task results to InstallResult format
    const results: InstallResult[] = dirs.map((dir, idx) => {
      const task = tasks[idx]
      if (!task) {
        return {
          _tag: 'failure',
          dir,
          error: new Error('Task not found'),
          stderr: '',
          stdout: '',
        }
      }

      const taskState = result.state.tasks[task.id]

      if (!taskState || taskState.status !== 'success') {
        const error = taskState?.error
          ? Option.getOrElse(taskState.error, () => 'Unknown error')
          : 'Task not found'
        const stderr = taskState?.stderr.join('\n') ?? ''
        const stdout = taskState?.stdout.join('\n') ?? ''

        return {
          _tag: 'failure',
          dir,
          error: new Error(error),
          stderr,
          stdout,
        }
      }

      return { _tag: 'success', dir }
    })

    return { results, total }
  }).pipe(Effect.withSpan('installAllWithTaskSystem'))

// =============================================================================
// Check Tasks
// =============================================================================

/** Configuration for check task system */
export interface CheckTasksConfig {
  oxcConfig: OxcConfig
  genieConfig: GenieCoverageConfig
  /** Skip genie check */
  skipGenie?: boolean
  /** Skip tests */
  skipTests?: boolean
}

/** Run all checks using task system with live progress */
export const checkAllWithTaskSystem = (config: CheckTasksConfig) =>
  Effect.gen(function* () {
    // Define parallel tasks (no dependencies)
    const parallelTasks = [
      ...(config.skipGenie
        ? []
        : [
            task({
              id: 'genie',
              name: 'Genie check',
              command: {
                cmd: 'genie',
                args: ['--check'],
              },
            }),
          ]),
      task({
        id: 'typecheck',
        name: 'Type checking',
        command: {
          cmd: resolveLocalTsc(),
          args: ['--build', 'tsconfig.all.json'],
        },
      }),
      task({
        id: 'lint',
        name: 'Lint (format + oxlint + genie coverage)',
        effect: allLintChecks(config),
      }),
    ]

    // Extract parallel task IDs for dependencies
    const parallelTaskIds = parallelTasks.map((t) => t.id)

    // Define sequential tasks (depend on all parallel tasks)
    const sequentialTasks = config.skipTests
      ? []
      : [
          task({
            id: 'test',
            name: 'Tests',
            command: {
              cmd: 'vitest',
              args: ['run'],
            },
            options: { dependencies: parallelTaskIds },
          }),
        ]

    const allTasks = [...parallelTasks, ...sequentialTasks]

    // Select renderer based on environment
    const renderer = IS_CI ? ciRenderer() : inlineRenderer()
    const result = yield* runTaskGraphOrFail({
      tasks: allTasks,
      options: {
        onStateChange: (state) => renderer.render(state),
      },
    })

    yield* renderer.renderFinal(result.state)

    return result
  }).pipe(Effect.withSpan('checkAllWithTaskSystem'))

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
