/**
 * dotdot sync command
 *
 * Collect member configs, merge into root config, clone missing repos
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import * as Prompt from '@effect/cli/Prompt'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import {
  type BaseResult,
  buildSummary,
  collectMemberConfigs,
  CurrentWorkingDirectory,
  type ExecutionMode,
  executeForAll,
  executeTopoForAll,
  findWorkspaceRoot,
  Git,
  loadRootConfig,
  mergeMemberConfigs,
  type PackageIndexEntry,
  type RepoConfig,
  RepoGraph,
  runShellCommand,
  writeGeneratedConfig,
} from '../lib/mod.ts'
import { pruneStaleSymlinks, syncSymlinks } from './link.ts'

/** Error during restore operation */
export class SyncError extends Schema.TaggedError<SyncError>()('SyncError', {
  repo: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of restoring a single repo */
type SyncResult = BaseResult<'cloned' | 'checked-out' | 'skipped' | 'failed'>

const SyncStatusLabels = {
  cloned: 'cloned',
  'checked-out': 'checked out',
  skipped: 'skipped',
  failed: 'failed',
} as const

/** Sync a single repo (clone if missing, checkout if pinned) */
const syncRepo = ({
  workspaceRoot,
  name,
  config,
  force,
}: {
  workspaceRoot: string
  name: string
  config: RepoConfig
  force: boolean
}) =>
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
            // Check for dirty working tree
            const isDirty = yield* Git.isDirty(repoPath)
            if (isDirty && !force) {
              return {
                name,
                status: 'skipped',
                message: 'Working tree has uncommitted changes (use --force to override)',
              } satisfies SyncResult
            }
            yield* Git.checkout({ repoPath, rev: config.rev, force })
            return {
              name,
              status: 'checked-out',
              message: `Checked out ${config.rev.slice(0, 7)}${force && isDirty ? ' (forced)' : ''}`,
            } satisfies SyncResult
          }
        }
        return {
          name,
          status: 'skipped',
          message: 'Already exists',
        } satisfies SyncResult
      } else {
        // Directory exists but not a git repo
        return {
          name,
          status: 'failed',
          message: 'Directory exists but is not a git repo',
        } satisfies SyncResult
      }
    }

    // Clone the repo
    yield* Git.clone({ url: config.url, targetPath: repoPath })

    // Checkout pinned rev if specified
    if (config.rev) {
      yield* Git.checkout({ repoPath, rev: config.rev })
    }

    // Run repo-level install command if specified
    if (config.install) {
      yield* runShellCommand({ command: config.install, cwd: repoPath })
    }

    const rev = yield* Git.getCurrentRev(repoPath)
    return {
      name,
      status: 'cloned',
      message: `Cloned at ${rev.slice(0, 7)}${config.install ? ' (installed)' : ''}`,
    } satisfies SyncResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      } satisfies SyncResult),
    ),
  )

/** Run package-level install commands */
const runPackageInstalls = ({
  workspaceRoot,
  packages,
}: {
  workspaceRoot: string
  packages: Record<string, PackageIndexEntry>
}) =>
  Effect.gen(function* () {
    const installedPackages: string[] = []

    for (const [pkgName, pkgConfig] of Object.entries(packages)) {
      if (pkgConfig.install) {
        const pkgPath = path.join(workspaceRoot, pkgConfig.repo, pkgConfig.path)
        yield* Effect.log(`  Installing package ${pkgName}...`)
        yield* runShellCommand({ command: pkgConfig.install, cwd: pkgPath }).pipe(
          Effect.catchAll((error) => {
            return Effect.logWarning(`  Failed to install ${pkgName}: ${error}`)
          }),
        )
        installedPackages.push(pkgName)
      }
    }

    return installedPackages
  })

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
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withDescription(
        'Force checkout pinned revisions even if working tree is dirty, overwrite existing symlinks',
      ),
      Cli.Options.withDefault(false),
    ),
  },
  ({ workspacePath, dryRun, mode, maxParallel, force }) =>
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

      // Collect member configs and merge
      const memberConfigs = yield* collectMemberConfigs(workspaceRoot)
      const merged = mergeMemberConfigs(memberConfigs)

      // Also load existing root config to preserve manually added repos
      const existingRoot = yield* loadRootConfig(workspaceRoot)

      // Merge repos: existing root repos + new deps from members
      const allRepos: Record<string, RepoConfig> = {
        ...existingRoot.config.repos,
        ...merged.repos,
      }

      // Add workspace members (directories with dotdot.json) to repos
      for (const memberName of merged.membersWithConfig) {
        if (memberName in allRepos) continue // Already tracked as a dependency

        const memberPath = path.join(workspaceRoot, memberName)
        const isGitRepo = yield* Git.isGitRepo(memberPath)
        if (!isGitRepo) continue

        const url = yield* Git.getRemoteUrl(memberPath)
        const rev = yield* Git.getCurrentRev(memberPath)
        allRepos[memberName] = { url, rev }
      }

      // Detect dangling repos (exist in workspace but no config and not a dependency)
      const entries = yield* fs.readDirectory(workspaceRoot)
      const danglingRepos: string[] = []
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const entryPath = path.join(workspaceRoot, entry)
        const stat = yield* fs.stat(entryPath)
        if (stat.type !== 'Directory') continue

        // Check if it's a git repo
        const isGitRepo = yield* Git.isGitRepo(entryPath)
        if (!isGitRepo) continue

        // Check if it has a config (workspace member) or is a dependency
        const hasConfig = merged.membersWithConfig.has(entry)
        const isDependency = merged.declaredDeps.has(entry) || entry in allRepos
        if (!hasConfig && !isDependency) {
          danglingRepos.push(entry)
        }
      }

      // Show warnings for dangling repos
      if (danglingRepos.length > 0) {
        yield* Effect.log('')
        yield* Effect.logWarning(`Found ${danglingRepos.length} dangling repo(s):`)
        for (const name of danglingRepos) {
          yield* Effect.logWarning(`  - ${name} (no config and not a dependency of anything)`)
        }
        yield* Effect.log('')
      }

      const repoCount = Object.keys(allRepos).length
      const packageCount = Object.keys(merged.packages).length

      if (repoCount === 0) {
        yield* Effect.log('No repos declared in member configs')
        return
      }

      yield* Effect.log(`Found ${repoCount} repo(s), ${packageCount} package(s)`)
      yield* Effect.log(`Execution mode: ${mode}`)
      yield* Effect.log('')

      // Check for dirty repos when --force is used
      if (force && !dryRun) {
        const dirtyRepos: string[] = []
        for (const [name] of Object.entries(allRepos)) {
          const repoPath = path.join(workspaceRoot, name)
          const exists = yield* fs.exists(repoPath)
          if (!exists) continue

          const isGitRepo = yield* Git.isGitRepo(repoPath)
          if (!isGitRepo) continue

          const isDirty = yield* Git.isDirty(repoPath)
          if (isDirty) {
            dirtyRepos.push(name)
          }
        }

        if (dirtyRepos.length > 0) {
          yield* Effect.logWarning(
            `${dirtyRepos.length} repo(s) have uncommitted changes that may be discarded:`,
          )
          for (const name of dirtyRepos) {
            yield* Effect.logWarning(`  - ${name}`)
          }
          yield* Effect.log('')

          const confirmed = yield* Prompt.confirm({
            message: 'Proceed and potentially discard local changes?',
            initial: false,
          })

          if (!confirmed) {
            yield* Effect.log('Aborted.')
            return
          }

          yield* Effect.log('')
        }
      }

      if (dryRun) {
        yield* Effect.log('Dry run - no changes will be made')
        yield* Effect.log('')

        for (const [name, config] of Object.entries(allRepos)) {
          const repoPath = path.join(workspaceRoot, name)
          const exists = yield* fs.exists(repoPath)
          if (exists) {
            yield* Effect.log(`  ${name}: would skip (already exists)`)
          } else {
            const installInfo = config.install ? ` (install: ${config.install})` : ''
            yield* Effect.log(`  ${name}: would clone from ${config.url}${installInfo}`)
          }
        }

        if (packageCount > 0) {
          yield* Effect.log('')
          yield* Effect.log('Packages to index:')
          for (const [name, pkg] of Object.entries(merged.packages)) {
            const installInfo = pkg.install ? ` (install: ${pkg.install})` : ''
            yield* Effect.log(`  ${name}: ${pkg.repo}/${pkg.path}${installInfo}`)
          }
        }
        return
      }

      // Sync repos with the specified execution mode
      const repoEntries = Object.entries(allRepos)
      const options = { mode, maxParallel: Option.getOrUndefined(maxParallel) }

      const executeFn = ([name, config]: [string, RepoConfig]) =>
        Effect.gen(function* () {
          yield* Effect.log(`Syncing ${name}...`)
          const result = yield* syncRepo({ workspaceRoot, name, config, force })
          yield* Effect.log(`  ${result.status}: ${result.message ?? ''}`)
          return result
        })

      let results: SyncResult[]

      if (mode === 'topo' || mode === 'topo-parallel') {
        // Build dependency graph for topological execution
        // Using member configs for dependency ordering
        const graph = RepoGraph.fromMemberConfigs(memberConfigs)

        results = yield* executeTopoForAll({
          items: repoEntries,
          fn: executeFn,
          graph,
          options,
        }).pipe(
          Effect.catchTag('CycleError', (e) =>
            Effect.gen(function* () {
              yield* Effect.log(`Error: ${e.message}`)
              yield* Effect.log('Please resolve circular dependencies before syncing.')
              return [] as SyncResult[]
            }),
          ),
        )
      } else {
        results = yield* executeForAll({ items: repoEntries, fn: executeFn, options })
      }

      // Run package install commands
      if (packageCount > 0) {
        yield* Effect.log('')
        yield* Effect.log('Running package installs...')
        yield* runPackageInstalls({ workspaceRoot, packages: merged.packages })
      }

      // Write the generated config with merged repos and packages
      yield* writeGeneratedConfig({ workspaceRoot, repos: allRepos, packages: merged.packages })

      // Sync symlinks for packages
      if (packageCount > 0) {
        yield* Effect.log('')
        yield* Effect.log('Syncing package symlinks...')

        const symlinkResult = yield* syncSymlinks({
          workspaceRoot,
          packages: merged.packages,
          dryRun,
          force,
        })

        // Report conflicts if any
        if (symlinkResult.conflicts.size > 0 && !force) {
          yield* Effect.logWarning('Package symlink conflicts detected:')
          for (const [targetName, sources] of symlinkResult.conflicts) {
            yield* Effect.logWarning(`  ${targetName}:`)
            for (const source of sources) {
              yield* Effect.logWarning(
                `    - ${source.sourceRepo}/${path.relative(path.join(workspaceRoot, source.sourceRepo), source.source)}`,
              )
            }
          }
          yield* Effect.log('Use --force to overwrite with the first match')
        }

        // Report created/overwritten symlinks
        if (symlinkResult.created.length > 0) {
          yield* Effect.log(`  Created ${symlinkResult.created.length} symlink(s)`)
        }
        if (symlinkResult.overwritten.length > 0) {
          yield* Effect.log(`  Overwritten ${symlinkResult.overwritten.length} symlink(s)`)
        }
        if (symlinkResult.skipped.length > 0) {
          yield* Effect.log(`  Skipped ${symlinkResult.skipped.length} symlink(s)`)
        }

        // Prune stale symlinks
        const pruneResult = yield* pruneStaleSymlinks({
          workspaceRoot,
          packages: merged.packages,
          dryRun,
        })

        if (pruneResult.removed.length > 0) {
          yield* Effect.log(`  Pruned ${pruneResult.removed.length} stale symlink(s)`)
        }
      }

      yield* Effect.log('')

      const summary = buildSummary({ results, statusLabels: SyncStatusLabels })
      yield* Effect.log(`Done: ${summary}`)
    }).pipe(Effect.withSpan('dotdot/sync')),
)
