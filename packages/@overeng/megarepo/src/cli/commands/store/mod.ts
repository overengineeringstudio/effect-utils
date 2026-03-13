/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import * as Cli from '@effect/cli'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
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

const collectStoreWorktrees = ({
  fs,
  refTypePath,
  currentPath,
  refType,
}: {
  fs: FileSystem.FileSystem
  refTypePath: AbsoluteDirPath
  currentPath: AbsoluteDirPath
  refType: 'heads' | 'tags' | 'commits'
}): Effect.Effect<
  Array<{
    ref: string
    refType: 'heads' | 'tags' | 'commits'
    path: AbsoluteDirPath
  }>,
  PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
    const isWorktree = yield* fs.exists(gitPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (isWorktree === true) {
      return [
        {
          ref: currentPath.slice(refTypePath.length).replace(/\/$/, ''),
          refType,
          path: currentPath,
        },
      ] as const
    }

    const entries = yield* fs.readDirectory(currentPath)
    const result: Array<{
      ref: string
      refType: 'heads' | 'tags' | 'commits'
      path: AbsoluteDirPath
    }> = []

    for (const entry of entries) {
      if (entry.startsWith('.') === true) continue

      const entryPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeDir(`${entry}/`))
      const entryStat = yield* fs.stat(entryPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (entryStat?.type !== 'Directory') continue

      result.push(
        ...(yield* collectStoreWorktrees({
          fs,
          refTypePath,
          currentPath: entryPath,
          refType,
        })),
      )
    }

    return result
  })

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

    // List all repos and analyze worktrees in parallel
    const repos = yield* store.listRepos()

    const repoResults = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )
          const bareExists = yield* fs.exists(bareRepoPath)

          const refsDir = EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('refs/'))
          const refsExists = yield* fs.exists(refsDir)
          if (refsExists === false) return []

          const refTypes = yield* fs.readDirectory(refsDir)
          const validRefTypes = refTypes.filter(
            (d): d is 'heads' | 'tags' | 'commits' =>
              d === 'heads' || d === 'tags' || d === 'commits',
          )

          const allWorktrees: Array<{
            ref: string
            refType: 'heads' | 'tags' | 'commits'
            path: AbsoluteDirPath
          }> = []

          for (const refTypeDir of validRefTypes) {
            const refTypePath = EffectPath.ops.join(
              refsDir,
              EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
            )
            const refTypeStat = yield* fs
              .stat(refTypePath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (refTypeStat?.type !== 'Directory') continue

            const worktrees = yield* collectStoreWorktrees({
              fs,
              refTypePath,
              currentPath: refTypePath,
              refType: refTypeDir,
            })
            allWorktrees.push(...worktrees)
          }

          // Analyze all worktrees for this repo in parallel
          return yield* Effect.all(
            allWorktrees.map(({ path: worktreePath, ref: expectedRef, refType: refTypeDir }) =>
              Effect.gen(function* () {
                const issues: StoreWorktreeIssue[] = []

                if (bareExists === false) {
                  issues.push({
                    type: 'missing_bare',
                    severity: 'error',
                    message: '.bare/ directory not found',
                  })
                }

                const gitPath = EffectPath.ops.join(
                  worktreePath,
                  EffectPath.unsafe.relativeFile('.git'),
                )
                const gitExists = yield* fs
                  .exists(gitPath)
                  .pipe(Effect.catchAll(() => Effect.succeed(false)))
                if (gitExists === false) {
                  issues.push({
                    type: 'broken_worktree',
                    severity: 'error',
                    message: '.git not found in worktree',
                  })
                } else {
                  if (refTypeDir === 'heads') {
                    const actualBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
                      Effect.catchAll(() => Effect.succeed(Option.none<string>())),
                    )
                    if (
                      Option.isSome(actualBranch) === true &&
                      actualBranch.value !== expectedRef
                    ) {
                      issues.push({
                        type: 'ref_mismatch',
                        severity: 'error',
                        message: `path says '${expectedRef}' but HEAD is '${actualBranch.value}'`,
                      })
                    }
                  }

                  const worktreeStatus = yield* Git.getWorktreeStatus(worktreePath).pipe(
                    Effect.catchAll(() =>
                      Effect.succeed({
                        isDirty: false,
                        hasUnpushed: false,
                        changesCount: 0,
                      }),
                    ),
                  )
                  if (worktreeStatus.isDirty === true) {
                    issues.push({
                      type: 'dirty',
                      severity: 'warning',
                      message: `${worktreeStatus.changesCount} uncommitted change${worktreeStatus.changesCount !== 1 ? 's' : ''}`,
                    })
                  }
                  if (worktreeStatus.hasUnpushed === true) {
                    issues.push({
                      type: 'unpushed',
                      severity: 'warning',
                      message: 'has unpushed commits',
                    })
                  }
                }

                if (inUsePaths.has(worktreePath) === false) {
                  issues.push({
                    type: 'orphaned',
                    severity: 'info',
                    message: 'not in current megarepo.lock',
                  })
                }

                return {
                  repo: repo.relativePath,
                  ref: expectedRef,
                  refType: refTypeDir,
                  path: worktreePath,
                  issues,
                } satisfies StoreWorktreeStatus
              }),
            ),
            { concurrency: 8 },
          )
        }),
      ),
      { concurrency: 8 },
    )

    const worktreeStatuses = repoResults.flat()
    const totalWorktreeCount = worktreeStatuses.length

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
              const message = error instanceof Error === true ? error.message : String(error)
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

      if (Option.isSome(root) === true && all === false) {
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
        all === false && Option.isNone(root) === true
          ? { type: 'not_in_megarepo' }
          : all === false && Option.isSome(root) === true
            ? { type: 'only_current_megarepo' }
            : undefined

      // List all repos and process their worktrees (parallel across repos,
      // sequential within a repo to avoid git conflicts on the same bare repo)
      const repos = yield* store.listRepos()

      const repoGcResults = yield* Effect.all(
        repos.map((repo) =>
          Effect.gen(function* () {
            const worktrees = yield* Effect.gen(function* () {
              const refsDir = EffectPath.ops.join(
                repo.fullPath,
                EffectPath.unsafe.relativeDir('refs/'),
              )
              const exists = yield* fs.exists(refsDir)
              if (exists === false) return []

              const result: Array<{
                ref: string
                refType: 'heads' | 'tags' | 'commits'
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

                result.push(
                  ...(yield* collectStoreWorktrees({
                    fs,
                    refTypePath,
                    currentPath: refTypePath,
                    refType: refTypeDir,
                  })),
                )
              }

              return result
            })

            // First: check status of all worktrees in parallel (the expensive part)
            const worktreeStatuses = yield* Effect.all(
              worktrees.map((worktree) =>
                Effect.gen(function* () {
                  if (inUsePaths.has(worktree.path) === true) {
                    return { worktree, action: 'skipped_in_use' as const, status: undefined }
                  }

                  const status = yield* Git.getWorktreeStatus(worktree.path).pipe(
                    Effect.catchAll(() =>
                      Effect.succeed({
                        isDirty: false,
                        hasUnpushed: false,
                        changesCount: 0,
                      }),
                    ),
                  )
                  return { worktree, action: 'check' as const, status }
                }),
              ),
              { concurrency: 8 },
            )

            // Then: process removals sequentially (git operations on the same bare repo)
            const repoResults: Array<{
              repo: string
              ref: string
              path: string
              status: 'removed' | 'skipped_dirty' | 'skipped_in_use' | 'error'
              message?: string
            }> = []

            for (const { worktree, action, status } of worktreeStatuses) {
              if (action === 'skipped_in_use') {
                repoResults.push({
                  repo: repo.relativePath,
                  ref: worktree.ref,
                  path: worktree.path,
                  status: 'skipped_in_use',
                })
                continue
              }

              if (
                status !== undefined &&
                (status.isDirty === true || status.hasUnpushed === true) &&
                force === false
              ) {
                repoResults.push({
                  repo: repo.relativePath,
                  ref: worktree.ref,
                  path: worktree.path,
                  status: 'skipped_dirty',
                  message:
                    status.isDirty === true
                      ? `${status.changesCount} uncommitted change(s)`
                      : 'has unpushed commits',
                })
                continue
              }

              if (dryRun === false) {
                yield* Effect.gen(function* () {
                  const bareRepoPath = EffectPath.ops.join(
                    repo.fullPath,
                    EffectPath.unsafe.relativeDir('.bare/'),
                  )
                  yield* Git.removeWorktree({
                    repoPath: bareRepoPath,
                    worktreePath: worktree.path,
                    force: force,
                  }).pipe(Effect.catchAll(() => fs.remove(worktree.path, { recursive: true })))
                }).pipe(
                  Effect.catchAll((error) =>
                    Effect.succeed({
                      error: error instanceof Error === true ? error.message : String(error),
                    }),
                  ),
                )
              }

              repoResults.push({
                repo: repo.relativePath,
                ref: worktree.ref,
                path: worktree.path,
                status: 'removed',
              })
            }

            return repoResults
          }),
        ),
        { concurrency: 8 },
      )

      const results = repoGcResults.flat()

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
      if (bareExists === false) {
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

      if (worktreeExists === false) {
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
      const commitOpt = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
      const commit = Option.getOrUndefined(commitOpt)

      // Use TuiApp for output
      const alreadyExists = bareExists && worktreeExists
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetAdd',
              status: alreadyExists === true ? 'already_exists' : 'added',
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
