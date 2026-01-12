/**
 * dotdot sync command
 *
 * Clone all declared repos that are missing
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import {
  CurrentWorkingDirectory,
  collectAllConfigs,
  type ExecutionMode,
  executeForAll,
  executeTopoForAll,
  findWorkspaceRoot,
  Git,
  Graph,
  type RepoConfig,
  runShellCommand,
  writeGeneratedConfig,
} from '../lib/mod.ts'

/** Error during restore operation */
export class SyncError extends Schema.TaggedError<SyncError>()('SyncError', {
  repo: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of restoring a single repo */
type SyncResult = {
  name: string
  status: 'cloned' | 'checked-out' | 'skipped' | 'failed'
  message?: string
}

/** Restore a single repo */
const syncRepo = (workspaceRoot: string, name: string, config: RepoConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const repoPath = path.join(workspaceRoot, name)

    // Check if directory exists
    const exists = yield* fs.exists(repoPath)

    if (exists) {
      // Check if it's a git repo
      const isGitRepo = yield* Git.isGitRepo(repoPath)
      if (isGitRepo) {
        // Already exists as git repo - check if we need to checkout pinned rev
        if (config.rev) {
          const currentRev = yield* Git.getCurrentRev(repoPath)
          if (!currentRev.startsWith(config.rev) && currentRev !== config.rev) {
            yield* Git.checkout(repoPath, config.rev)
            return {
              name,
              status: 'checked-out',
              message: `Checked out ${config.rev.slice(0, 7)}`,
            } as SyncResult
          }
        }
        return {
          name,
          status: 'skipped',
          message: 'Already exists',
        } as SyncResult
      } else {
        // Directory exists but not a git repo
        return {
          name,
          status: 'failed',
          message: 'Directory exists but is not a git repo',
        } as SyncResult
      }
    }

    // Clone the repo
    yield* Git.clone(config.url, repoPath)

    // Checkout pinned rev if specified
    if (config.rev) {
      yield* Git.checkout(repoPath, config.rev)
    }

    // Run repo-level install command if specified
    if (config.install) {
      yield* runShellCommand(config.install, repoPath)
    }

    // Run package-level install commands
    const packageInstalls: string[] = []
    if (config.packages) {
      for (const [pkgName, pkgConfig] of Object.entries(config.packages)) {
        if (pkgConfig.install) {
          const pkgPath = path.join(repoPath, pkgConfig.path)
          yield* runShellCommand(pkgConfig.install, pkgPath)
          packageInstalls.push(pkgName)
        }
      }
    }

    const rev = yield* Git.getCurrentRev(repoPath)
    const installInfo = config.install || packageInstalls.length > 0
    return {
      name,
      status: 'cloned',
      message: `Cloned at ${rev.slice(0, 7)}${installInfo ? ' (installed)' : ''}`,
    } as SyncResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      } as SyncResult),
    ),
  )

/** Collect all declared repos from configs */
const collectDeclaredRepos = (
  configs: Array<{
    config: { repos: Record<string, RepoConfig> }
    isRoot: boolean
    dir: string
  }>,
) => {
  const repos = new Map<string, RepoConfig>()

  for (const source of configs) {
    for (const [name, config] of Object.entries(source.config.repos)) {
      // First declaration wins (root config takes precedence)
      if (!repos.has(name)) {
        repos.set(name, config)
      }
    }
  }

  return repos
}

/** Sync command implementation */
export const syncCommand = Cli.Command.make(
  'sync',
  {
    workspacePath: Cli.Args.directory({ name: 'path' }).pipe(
      Cli.Args.withDescription('Workspace path (required for first-time init, optional after)'),
      Cli.Args.optional,
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    mode: Cli.Options.choice('mode', [
      'parallel',
      'sequential',
      'topo',
      'topo-parallel',
    ] as const).pipe(
      Cli.Options.withDescription(
        'Execution mode: parallel, sequential, topo (dependency order), or topo-parallel',
      ),
      Cli.Options.withDefault('topo' as ExecutionMode),
    ),
    maxParallel: Cli.Options.integer('max-parallel').pipe(
      Cli.Options.withDescription(
        'Maximum parallel operations (for parallel and topo-parallel modes)',
      ),
      Cli.Options.optional,
    ),
  },
  ({ workspacePath, dryRun, mode, maxParallel }) =>
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory
      const fs = yield* FileSystem.FileSystem

      // Determine workspace root:
      // - If path argument provided, use it (for initialization)
      // - Otherwise, find existing workspace by looking for generated config
      const workspaceRoot = Option.isSome(workspacePath)
        ? path.resolve(Option.getOrThrow(workspacePath))
        : yield* findWorkspaceRoot(cwd)

      yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)

      // Collect all configs
      const configs = yield* collectAllConfigs(workspaceRoot)

      // Get declared repos
      const declaredRepos = collectDeclaredRepos(configs)

      if (declaredRepos.size === 0) {
        yield* Effect.log('No repos declared in config')
        return
      }

      yield* Effect.log(`Found ${declaredRepos.size} declared repo(s)`)
      yield* Effect.log(`Execution mode: ${mode}`)
      yield* Effect.log('')

      if (dryRun) {
        yield* Effect.log('Dry run - no changes will be made')
        yield* Effect.log('')

        for (const [name, config] of declaredRepos.entries()) {
          const repoPath = path.join(workspaceRoot, name)
          const exists = yield* fs.exists(repoPath)
          if (exists) {
            yield* Effect.log(`  ${name}: would skip (already exists)`)
          } else {
            const installSteps: string[] = []
            if (config.install) installSteps.push(`repo install: ${config.install}`)
            if (config.packages) {
              for (const [pkgName, pkgConfig] of Object.entries(config.packages)) {
                if (pkgConfig.install) {
                  installSteps.push(`package ${pkgName}: ${pkgConfig.install}`)
                }
              }
            }
            const installInfo = installSteps.length > 0 ? ` (${installSteps.join(', ')})` : ''
            yield* Effect.log(`  ${name}: would clone from ${config.url}${installInfo}`)
          }
        }
        return
      }

      // Sync repos with the specified execution mode
      const repoEntries = Array.from(declaredRepos.entries())
      const options = { mode, maxParallel: Option.getOrUndefined(maxParallel) }

      const executeFn = ([name, config]: [string, RepoConfig]) =>
        Effect.gen(function* () {
          yield* Effect.log(`Syncing ${name}...`)
          const result = yield* syncRepo(workspaceRoot, name, config)
          yield* Effect.log(`  ${result.status}: ${result.message ?? ''}`)
          return result
        })

      let results: SyncResult[]

      if (mode === 'topo' || mode === 'topo-parallel') {
        // Build dependency graph for topological execution
        const graph = Graph.buildFromConfigs(configs, (dir) => path.basename(dir))

        results = yield* executeTopoForAll(repoEntries, executeFn, graph, options).pipe(
          Effect.catchTag('CycleError', (e) =>
            Effect.gen(function* () {
              yield* Effect.log(`Error: ${e.message}`)
              yield* Effect.log('Please resolve circular dependencies before syncing.')
              return [] as SyncResult[]
            }),
          ),
        )
      } else {
        results = yield* executeForAll(repoEntries, executeFn, options)
      }

      // Write the generated config with merged repos
      const mergedConfig = { repos: Object.fromEntries(declaredRepos) }
      yield* writeGeneratedConfig(workspaceRoot, mergedConfig)

      yield* Effect.log('')

      const cloned = results.filter((r) => r.status === 'cloned').length
      const checkedOut = results.filter((r) => r.status === 'checked-out').length
      const skipped = results.filter((r) => r.status === 'skipped').length
      const failed = results.filter((r) => r.status === 'failed').length

      const summary: string[] = []
      if (cloned > 0) summary.push(`${cloned} cloned`)
      if (checkedOut > 0) summary.push(`${checkedOut} checked out`)
      if (skipped > 0) summary.push(`${skipped} skipped`)
      if (failed > 0) summary.push(`${failed} failed`)

      yield* Effect.log(`Done: ${summary.join(', ')}`)
    }).pipe(Effect.withSpan('dotdot/sync')),
)
