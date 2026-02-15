/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import {
  CONFIG_FILE_NAME,
  MegarepoConfig,
  parseSourceString,
  isRemoteSource,
  getSourceRef,
} from '../../../lib/config.ts'
import * as Git from '../../../lib/git.ts'
import { type LockFile, LOCK_FILE_NAME, readLockFile } from '../../../lib/lock.ts'
import { classifyRef } from '../../../lib/ref.ts'
import { Store, StoreLayer } from '../../../lib/store.ts'
import { getCloneUrl } from '../../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { StoreCommandError } from '../../errors.ts'
import { StoreApp, StoreView } from '../../renderers/StoreOutput/mod.ts'
import type { StoreWorktreeStatus, StoreWorktreeIssue } from '../../renderers/StoreOutput/mod.ts'

/** List repos in the store */
const storeLsCommand = Cli.Command.make('ls', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()

    yield* run(
      StoreApp,
      (tui) =>
        Effect.sync(() => {
          tui.dispatch({
            _tag: 'SetLs',
            basePath: store.basePath,
            repos: repos.map((r) => ({ relativePath: r.relativePath })),
          })
        }),
      { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/ls')),
).pipe(Cli.Command.withDescription('List repositories in the store'))

/** Show store status and detect issues */
const storeStatusCommand = Cli.Command.make('status', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem

    // Get lock file from current megarepo (if any) to determine orphaned worktrees
    const root = yield* findMegarepoRoot(cwd)
    let inUsePaths = new Set<string>()

    if (Option.isSome(root) === true) {
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      const lockFile = Option.getOrUndefined(lockFileOpt)

      if (lockFile !== undefined) {
        const configPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* fs.readFileString(configPath)
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

        for (const [name, sourceString] of Object.entries(config.members)) {
          const source = parseSourceString(sourceString)
          if (source === undefined || isRemoteSource(source) === false) continue

          const lockedMember = lockFile.members[name]
          if (lockedMember === undefined) continue

          const worktreePath = store.getWorktreePath({
            source,
            ref: lockedMember.ref,
          })
          inUsePaths.add(worktreePath)
        }
      }
    }

    // List all repos and analyze worktrees
    const repos = yield* store.listRepos()
    const worktreeStatuses: StoreWorktreeStatus[] = []
    let totalWorktreeCount = 0

    for (const repo of repos) {
      // Check if .bare/ exists
      const bareRepoPath = EffectPath.ops.join(
        repo.fullPath,
        EffectPath.unsafe.relativeDir('.bare/'),
      )
      const bareExists = yield* fs.exists(bareRepoPath)

      // List worktrees for this repo
      const refsDir = EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('refs/'))
      const refsExists = yield* fs.exists(refsDir)
      if (!refsExists) continue

      const refTypes = yield* fs.readDirectory(refsDir)
      for (const refTypeDir of refTypes) {
        if (refTypeDir !== 'heads' && refTypeDir !== 'tags' && refTypeDir !== 'commits') continue

        const refTypePath = EffectPath.ops.join(
          refsDir,
          EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
        )
        const refTypeStat = yield* fs
          .stat(refTypePath)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (refTypeStat?.type !== 'Directory') continue

        const encodedRefs = yield* fs.readDirectory(refTypePath)
        for (const encodedRef of encodedRefs) {
          const worktreePath = EffectPath.ops.join(
            refTypePath,
            EffectPath.unsafe.relativeDir(`${encodedRef}/`),
          ) as AbsoluteDirPath
          const worktreeStat = yield* fs
            .stat(worktreePath)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (worktreeStat?.type !== 'Directory') continue

          totalWorktreeCount++
          const expectedRef = decodeURIComponent(encodedRef)
          const issues: StoreWorktreeIssue[] = []

          // Check for missing bare repo
          if (!bareExists) {
            issues.push({
              type: 'missing_bare',
              severity: 'error',
              message: '.bare/ directory not found',
            })
          }

          // Check if worktree is a valid git repo
          // In worktrees, .git is a file (not directory) containing "gitdir: <path>"
          const gitPath = EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('.git'))
          const gitExists = yield* fs
            .exists(gitPath)
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
          if (!gitExists) {
            issues.push({
              type: 'broken_worktree',
              severity: 'error',
              message: '.git not found in worktree',
            })
          } else {
            // Check for ref mismatch (only for branches)
            if (refTypeDir === 'heads') {
              const actualBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
                Effect.catchAll(() => Effect.succeed(Option.none<string>())),
              )
              if (Option.isSome(actualBranch) === true && actualBranch.value !== expectedRef) {
                issues.push({
                  type: 'ref_mismatch',
                  severity: 'error',
                  message: `path says '${expectedRef}' but HEAD is '${actualBranch.value}'`,
                })
              }
            }

            // Check for dirty worktree
            const worktreeStatus = yield* Git.getWorktreeStatus(worktreePath).pipe(
              Effect.catchAll(() =>
                Effect.succeed({
                  isDirty: false,
                  hasUnpushed: false,
                  changesCount: 0,
                }),
              ),
            )
            if (worktreeStatus.isDirty) {
              issues.push({
                type: 'dirty',
                severity: 'warning',
                message: `${worktreeStatus.changesCount} uncommitted change${worktreeStatus.changesCount !== 1 ? 's' : ''}`,
              })
            }
            if (worktreeStatus.hasUnpushed) {
              issues.push({
                type: 'unpushed',
                severity: 'warning',
                message: 'has unpushed commits',
              })
            }
          }

          // Check if orphaned (not in current megarepo's lock)
          if (inUsePaths.has(worktreePath) === false) {
            issues.push({
              type: 'orphaned',
              severity: 'info',
              message: 'not in current megarepo.lock',
            })
          }

          worktreeStatuses.push({
            repo: repo.relativePath,
            ref: expectedRef,
            refType: refTypeDir as 'heads' | 'tags' | 'commits',
            path: worktreePath,
            issues,
          })
        }
      }
    }

    // Use TuiApp for output
    yield* run(
      StoreApp,
      (tui) =>
        Effect.sync(() => {
          tui.dispatch({
            _tag: 'SetStatus',
            basePath: store.basePath,
            repoCount: repos.length,
            worktreeCount: totalWorktreeCount,
            worktrees: worktreeStatuses,
          })
        }),
      { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/status')),
).pipe(Cli.Command.withDescription('Show store status and detect issues'))

/** Fetch all repos in the store */
const storeFetchCommand = Cli.Command.make('fetch', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()
    const startTime = Date.now()

    // Fetch repos with limited concurrency
    const results = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )

          return yield* Git.fetchBare({
            repoPath: bareRepoPath,
          }).pipe(
            Effect.map(() => ({ path: repo.relativePath, status: 'fetched' as const })),
            Effect.catchAll((error) => {
              const message = error instanceof Error ? error.message : String(error)
              return Effect.succeed({
                path: repo.relativePath,
                status: 'error' as const,
                message,
              })
            }),
          )
        }),
      ),
      { concurrency: 4 },
    )

    const elapsed = Date.now() - startTime

    // Use StoreApp for all output modes
    yield* run(
      StoreApp,
      (tui) =>
        Effect.sync(() => {
          tui.dispatch({
            _tag: 'SetFetch',
            basePath: store.basePath,
            results: results,
            elapsedMs: elapsed,
          })
        }),
      { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/fetch')),
).pipe(Cli.Command.withDescription('Fetch all repositories in the store'))

/**
 * Garbage collect unused worktrees from the store.
 * Removes worktrees that are not referenced by any megarepo's lock file.
 */
const storeGcCommand = Cli.Command.make(
  'gc',
  {
    output: outputOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be removed without removing'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Remove dirty worktrees (with uncommitted changes)'),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Remove all worktrees (not just unused ones)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, dryRun, force, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      // Get lock file from current megarepo (if any)
      const root = yield* findMegarepoRoot(cwd)
      let lockFile: LockFile | undefined
      let inUsePaths = new Set<string>()

      if (Option.isSome(root) === true && !all) {
        const lockPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const lockFileOpt = yield* readLockFile(lockPath)
        lockFile = Option.getOrUndefined(lockFileOpt)

        // Build set of worktree paths that are "in use"
        if (lockFile !== undefined) {
          const configPath = EffectPath.ops.join(
            root.value,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const configContent = yield* fs.readFileString(configPath)
          const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            configContent,
          )

          for (const [name, sourceString] of Object.entries(config.members)) {
            const source = parseSourceString(sourceString)
            if (source === undefined || isRemoteSource(source) === false) continue

            const lockedMember = lockFile.members[name]
            if (lockedMember === undefined) continue

            // Mark the worktree path as in use
            const worktreePath = store.getWorktreePath({
              source,
              ref: lockedMember.ref,
            })
            inUsePaths.add(worktreePath)
          }
        }
      }

      // Determine warning type for output
      const gcWarning: { type: 'not_in_megarepo' | 'only_current_megarepo' } | undefined =
        !all && Option.isNone(root) === true
          ? { type: 'not_in_megarepo' }
          : !all && Option.isSome(root) === true
            ? { type: 'only_current_megarepo' }
            : undefined

      // List all repos and their worktrees
      const repos = yield* store.listRepos()
      const results: Array<{
        repo: string
        ref: string
        path: string
        status: 'removed' | 'skipped_dirty' | 'skipped_in_use' | 'error'
        message?: string
      }> = []

      for (const repo of repos) {
        // List worktrees for this repo
        // We need to construct a mock source for listing
        const worktrees = yield* Effect.gen(function* () {
          const refsDir = EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('refs/'))
          const exists = yield* fs.exists(refsDir)
          if (!exists) return []

          const result: Array<{
            ref: string
            refType: string
            path: AbsoluteDirPath
          }> = []

          const refTypes = yield* fs.readDirectory(refsDir)
          for (const refTypeDir of refTypes) {
            if (refTypeDir !== 'heads' && refTypeDir !== 'tags' && refTypeDir !== 'commits')
              continue

            const refTypePath = EffectPath.ops.join(
              refsDir,
              EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
            )
            const refTypeStat = yield* fs
              .stat(refTypePath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (refTypeStat?.type !== 'Directory') continue

            const encodedRefs = yield* fs.readDirectory(refTypePath)
            for (const encodedRef of encodedRefs) {
              const worktreePath = EffectPath.ops.join(
                refTypePath,
                EffectPath.unsafe.relativeDir(`${encodedRef}/`),
              )
              const worktreeStat = yield* fs
                .stat(worktreePath)
                .pipe(Effect.catchAll(() => Effect.succeed(null)))
              if (worktreeStat?.type !== 'Directory') continue

              const ref = decodeURIComponent(encodedRef)
              result.push({ ref, refType: refTypeDir, path: worktreePath })
            }
          }

          return result
        })

        for (const worktree of worktrees) {
          // Check if worktree is in use
          if (inUsePaths.has(worktree.path) === true) {
            results.push({
              repo: repo.relativePath,
              ref: worktree.ref,
              path: worktree.path,
              status: 'skipped_in_use',
            })
            continue
          }

          // Check if worktree is dirty
          const status = yield* Git.getWorktreeStatus(worktree.path).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                isDirty: false,
                hasUnpushed: false,
                changesCount: 0,
              }),
            ),
          )

          if ((status.isDirty || status.hasUnpushed) && !force) {
            results.push({
              repo: repo.relativePath,
              ref: worktree.ref,
              path: worktree.path,
              status: 'skipped_dirty',
              message: status.isDirty
                ? `${status.changesCount} uncommitted change(s)`
                : 'has unpushed commits',
            })
            continue
          }

          // Remove the worktree
          if (!dryRun) {
            yield* Effect.gen(function* () {
              const bareRepoPath = EffectPath.ops.join(
                repo.fullPath,
                EffectPath.unsafe.relativeDir('.bare/'),
              )
              yield* Git.removeWorktree({
                repoPath: bareRepoPath,
                worktreePath: worktree.path,
                force: force,
              }).pipe(
                Effect.catchAll(() =>
                  // If git worktree remove fails, try removing the directory directly
                  fs.remove(worktree.path, { recursive: true }),
                ),
              )
            }).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            )
          }

          results.push({
            repo: repo.relativePath,
            ref: worktree.ref,
            path: worktree.path,
            status: 'removed',
          })
        }
      }

      // Use TuiApp for output
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetGc',
              basePath: store.basePath,
              results: results,
              dryRun,
              warning: gcWarning,
              showForceHint: !force,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/gc')),
).pipe(Cli.Command.withDescription('Garbage collect unused worktrees'))

/**
 * Add a repository to the store without adding it to a megarepo.
 * Useful for pre-populating the cache or CI warm-up.
 */
const storeAddCommand = Cli.Command.make(
  'add',
  {
    source: Cli.Args.text({ name: 'source' }).pipe(
      Cli.Args.withDescription('Repository source (owner/repo, URL, or owner/repo#ref)'),
    ),
    output: outputOption,
  },
  ({ source: sourceString, output }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      // Parse the source string
      const source = parseSourceString(sourceString)
      if (source === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'invalid_source',
                message: `Invalid source string: ${sourceString}`,
                source: sourceString,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Invalid source' })
      }

      if (isRemoteSource(source) === false) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'local_path',
                message: 'Cannot add local path to store',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot add local path' })
      }

      const cloneUrl = getCloneUrl(source)
      if (cloneUrl === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'no_url',
                message: 'Cannot determine clone URL',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot get clone URL' })
      }

      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* store.hasBareRepo(source)

      // Clone if needed (show progress for non-JSON modes)
      if (!bareExists) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
      }

      // Determine ref to use
      const sourceRef = getSourceRef(source)
      let targetRef: string
      if (Option.isSome(sourceRef) === true) {
        targetRef = sourceRef.value
      } else {
        // Get default branch
        const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
        targetRef = Option.getOrElse(defaultBranch, () => 'main')
      }

      // Create worktree if needed
      const refType = classifyRef(targetRef)
      const worktreePath = store.getWorktreePath({ source, ref: targetRef, refType })
      const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef, refType })

      if (!worktreeExists) {
        const worktreeParent = EffectPath.ops.parent(worktreePath)
        if (worktreeParent !== undefined) {
          yield* fs.makeDirectory(worktreeParent, { recursive: true })
        }

        if (refType === 'commit' || refType === 'tag') {
          yield* Git.createWorktreeDetached({
            repoPath: bareRepoPath,
            worktreePath,
            commit: targetRef,
          })
        } else {
          yield* Git.createWorktree({
            repoPath: bareRepoPath,
            worktreePath,
            branch: targetRef,
            createBranch: false,
          }).pipe(
            Effect.catchAll(() =>
              Git.createWorktree({
                repoPath: bareRepoPath,
                worktreePath,
                branch: `origin/${targetRef}`,
                createBranch: false,
              }),
            ),
            Effect.catchAll(() =>
              Git.createWorktreeDetached({
                repoPath: bareRepoPath,
                worktreePath,
                commit: targetRef,
              }),
            ),
          )
        }
      }

      // Get the current commit
      const commit = yield* Git.getCurrentCommit(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )

      // Use TuiApp for output
      const alreadyExists = bareExists && worktreeExists
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetAdd',
              status: alreadyExists ? 'already_exists' : 'added',
              source: sourceString,
              ref: targetRef,
              commit,
              path: worktreePath,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/add')),
).pipe(Cli.Command.withDescription('Add a repository to the store (without adding to megarepo)'))

/** Store subcommand group */
export const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([
    storeAddCommand,
    storeLsCommand,
    storeStatusCommand,
    storeFetchCommand,
    storeGcCommand,
  ]),
  Cli.Command.withDescription('Manage the shared git store'),
)
