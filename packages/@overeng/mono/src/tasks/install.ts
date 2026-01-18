/**
 * Package installation tasks.
 */

import { cpus } from 'node:os'

import { FileSystem, Path } from '@effect/platform'
import * as Command from '@effect/platform/Command'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import { Array, Effect, Logger, LogLevel, Option, Schedule, Stream } from 'effect'

import { task } from '../task-system/api.ts'
import type { CommandError } from '../task-system/execution.ts'
import { runTaskGraph } from '../task-system/graph.ts'
import { ciRenderer } from '../task-system/renderers/ci.ts'
import { piTuiInlineRenderer } from '../task-system/renderers/pi-tui-inline.ts'
import type { TaskDef } from '../task-system/types.ts'
import { IS_CI, runCommand } from '../utils.ts'
import type { InstallConfig, InstallProgress, InstallResult } from './types.ts'

/** Default directories to skip when scanning for packages */
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.devenv', '.direnv'])

/** Find all directories containing package.json files */
export const findPackageDirs = Effect.fn('findPackageDirs')(function* (config: InstallConfig) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])])

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
        } else if (entry === 'package.json') {
          results.push(dir)
        }
      }

      return results
    },
  )

  const allDirs: string[] = []
  for (const scanDir of config.scanDirs) {
    const dirs = yield* walk(pathService.join(cwd, scanDir))
    allDirs.push(...dirs)
  }

  return allDirs.toSorted()
})

/**
 * Remove node_modules directories for all packages that will be installed.
 *
 * @deprecated Use installAllWithTaskSystem with clean: true option instead.
 * This provides better progress visibility through the task system.
 */
export const cleanNodeModules = Effect.fn('cleanNodeModules')(function* (config: InstallConfig) {
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
})

/** Install dependencies for a single package directory (captures output, never fails) */
export const installPackageCaptured = Effect.fn('installPackageCaptured')(function* (opts: {
  dir: string
  options?: { frozenLockfile?: boolean }
}) {
  const { dir, options } = opts
  const args = ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])]

  const command = Command.make('bun', ...args).pipe(
    Command.workingDirectory(dir),
    Command.stdout('pipe'),
    Command.stderr('pipe'),
  )

  const result: InstallResult = yield* Effect.scoped(
    Command.start(command).pipe(
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
      Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
    ),
  )

  return result
})

/** Install dependencies for a single package directory */
export const installPackage = Effect.fn('installPackage')(function* (opts: {
  dir: string
  options?: { frozenLockfile?: boolean }
}) {
  const { dir, options } = opts
  return yield* runCommand({
    command: 'bun',
    args: ['install', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])],
    cwd: dir,
  })
})

/** Install dependencies for all packages in parallel with progress tracking */
export const installAll = Effect.fn('installAll')(function* (opts: {
  config: InstallConfig
  options?: {
    frozenLockfile?: boolean
    onProgress?: (progress: InstallProgress) => Effect.Effect<void>
  }
}) {
  const { config, options } = opts
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
})

/**
 * Install dependencies using task system with live progress (task-based implementation).
 *
 * The `clean` option is currently needed as a workaround for a bun bug where parallel installs
 * with file: protocol dependencies and postinstall scripts cause cache corruption.
 * See: file:///Users/schickling/Code/overengineeringstudio/dotdot/effect-utils/context/workarounds/bun-patched-dependencies.md
 */
export const installAllWithTaskSystem = Effect.fn('installAllWithTaskSystem')(function* (opts: {
  config: InstallConfig
  options?: {
    frozenLockfile?: boolean
    /** Clean node_modules before installing (workaround for bun cache corruption with file: deps) */
    clean?: boolean
  }
}) {
  const { config, options } = opts
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

  const dirs = yield* findPackageDirs(config)
  const total = dirs.length

  if (total === 0) {
    return { results: [], total: 0 }
  }

  // Create log directory for task output persistence
  const logDir = pathService.join(cwd, 'tmp', 'install-logs')
  yield* fs.makeDirectory(logDir, { recursive: true }).pipe(
    Effect.catchAll(() => Effect.void), // Ignore if already exists
  )

  // Create tasks for each package directory
  // All tasks are command tasks with the same error/requirements types
  const tasks: TaskDef<string, void, CommandError | PlatformError, CommandExecutor.CommandExecutor>[] = []

  for (const dir of dirs) {
    const relativePath = pathService.relative(cwd, dir)
    const taskId = relativePath.replace(/\//g, ':') // Convert path to valid task ID
    const nodeModulesPath = pathService.join(dir, 'node_modules')

    // If clean is requested, create clean task first
    if (options?.clean) {
      tasks.push(
        task({
          id: `clean:${taskId}`,
          name: `Clean ${relativePath}`,
          command: {
            cmd: 'rm',
            args: ['-rf', nodeModulesPath],
            cwd: dir,
          },
        }),
      )
    }

    // Log file path for task output persistence
    const logFileName = relativePath.replace(/\//g, '-')
    const logFile = pathService.join(logDir, `${logFileName}.log`)

    // Create install task (depends on clean task if present)
    tasks.push(
      task({
        id: `install:${taskId}`,
        name: `Install ${relativePath}`,
        command: {
          cmd: 'bun',
          // TODO remove `--verbose` once we figured out the bun install hang bug (send logs to Jarred as we have a repro)
          args: ['install', '--verbose', ...(options?.frozenLockfile ? ['--frozen-lockfile'] : [])],
          cwd: dir,
        },
        options: {
          // Retry with exponential backoff to handle bun cache race conditions
          // Attempts: 200ms, 400ms, 800ms (total ~3 retries)
          retrySchedule: Schedule.exponential('200 millis').pipe(
            Schedule.compose(Schedule.recurs(3)),
          ),
          maxRetries: 3,
          // Install depends on clean if clean task exists
          ...(options?.clean ? { dependencies: [`clean:${taskId}`] } : {}),
          // Persist output to log file for debugging
          logFile,
        },
      }),
    )
  }

  // Select renderer based on environment
  // Limit concurrency to number of CPU cores to avoid bun cache race conditions
  const concurrency = cpus().length
  const renderer = IS_CI ? ciRenderer() : piTuiInlineRenderer()
  const result = yield* runTaskGraph({
    tasks,
    options: {
      onStateChange: (state) => renderer.render(state),
      concurrency,
    },
  })

  yield* renderer.renderFinal(result.state)

  // Convert task results to InstallResult format
  // Look up install task state for each directory (clean tasks are not reported)
  const results: InstallResult[] = dirs.map((dir) => {
    const relativePath = pathService.relative(cwd, dir)
    const taskId = relativePath.replace(/\//g, ':')
    const installTaskId = `install:${taskId}`

    const taskState = result.state.tasks[installTaskId]

    if (!taskState || taskState.status !== 'success') {
      const errorMessage: string = taskState?.error
        ? Option.getOrElse(taskState.error, () => 'Unknown error')
        : 'Task not found'
      const stderr = taskState?.stderr.join('\n') ?? ''
      const stdout = taskState?.stdout.join('\n') ?? ''

      return {
        _tag: 'failure',
        dir,
        error: new Error(errorMessage),
        stderr,
        stdout,
      }
    }

    return { _tag: 'success', dir }
  })

  return { results, total }
})
