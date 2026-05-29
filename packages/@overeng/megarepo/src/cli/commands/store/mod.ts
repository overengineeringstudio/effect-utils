/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import * as Cli from '@effect/cli'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, Schedule, Stream } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { OutputModeTag, run } from '@overeng/tui-react'

import {
  parseSourceString,
  isRemoteSource,
  getSourceRef,
  readMegarepoConfig,
} from '../../../lib/config.ts'
import * as Git from '../../../lib/git.ts'
import { LOCK_FILE_NAME, readLockFile } from '../../../lib/lock.ts'
import { classifyRef } from '../../../lib/ref.ts'
import { validateStoreMembers, fixStoreIssues } from '../../../lib/store-hygiene.ts'
import { collectStoreLiveSet, type StoreLiveSet } from '../../../lib/store-liveness.ts'
import { StoreLock } from '../../../lib/store-lock.ts'
import { classifyStoreWorktreePolicy } from '../../../lib/store-worktree-policy.ts'
import { Store, StoreLayer } from '../../../lib/store.ts'
import { getCloneUrl } from '../../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { StoreCommandError } from '../../errors.ts'
import { StoreApp, StoreView } from '../../renderers/StoreOutput/mod.ts'
import type {
  StoreAction,
  StoreGcResult,
  StoreWorktreeStatus,
  StoreWorktreeIssue,
} from '../../renderers/StoreOutput/mod.ts'

/** Entry returned by collectStoreWorktrees — `broken` indicates a directory that looks like a worktree but is missing its .git file */
type CollectedWorktree = {
  ref: string
  refType: 'heads' | 'tags' | 'commits'
  path: AbsoluteDirPath
  broken: boolean
}

type GcWorktreeDecision =
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'skipped_in_use'
      readonly message?: string | undefined
    }
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'status_failed'
      readonly message: string
    }
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'check'
      readonly status: {
        readonly isDirty: boolean
        readonly hasUnpushed: boolean
        readonly changesCount: number
      }
    }

const GC_REPO_CONCURRENCY = 1
const GC_WORKTREE_CONCURRENCY = 1
const GC_PROGRESS_BATCH_SIZE = 10
const STORE_REF_TYPES = ['heads', 'tags', 'commits'] as const

const runStoreCommand = ({ output, action }: { output: string; action: StoreAction }) => {
  const visualEffect = run(
    StoreApp,
    (tui) =>
      Effect.sync(() => {
        tui.dispatch(action)
      }),
    { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
  )

  const jsonEffect = Effect.gen(function* () {
    const mode = yield* OutputModeTag
    if (mode._tag !== 'json' || mode.timing !== 'final') {
      return yield* visualEffect
    }

    return yield* run(StoreApp, (tui) =>
      Effect.sync(() => {
        tui.dispatch(action)
      }),
    )
  })

  return jsonEffect.pipe(Effect.provide(outputModeLayer(output as never)))
}

const toStoreGcAction = ({
  basePath,
  results,
  dryRun,
  warning,
  force,
  repoCount,
  completedRepoCount,
  discoveredWorktreeCount,
  activeWorktreeCount,
  statusMessage,
  done,
}: {
  basePath: string
  results: ReadonlyArray<StoreGcResult>
  dryRun: boolean
  warning: { type: 'not_in_megarepo' | 'only_current_megarepo' } | undefined
  force: boolean
  repoCount: number | undefined
  completedRepoCount: number
  discoveredWorktreeCount: number
  activeWorktreeCount: number
  statusMessage: string | undefined
  done: boolean
}): StoreAction => ({
  _tag: 'SetGc',
  basePath,
  results: [...results],
  dryRun,
  warning,
  showForceHint: !force,
  processedCount: results.length,
  repoCount,
  completedRepoCount,
  discoveredWorktreeCount,
  activeWorktreeCount,
  statusMessage,
  done,
})

const classifyGcProtection = ({
  store,
  currentWorkspaceRoot,
  worktree,
  all,
}: {
  store: Effect.Effect.Success<typeof Store>
  currentWorkspaceRoot: Option.Option<AbsoluteDirPath>
  worktree: CollectedWorktree
  all: boolean
}) =>
  Effect.gen(function* () {
    const liveSet = yield* collectStoreLiveSet({
      store,
      ...(Option.isSome(currentWorkspaceRoot) === true
        ? { currentWorkspaceRoot: currentWorkspaceRoot.value }
        : {}),
      pruneStaleRegistry: true,
      refreshCurrentWorkspace: false,
    })

    return classifyStoreWorktreePolicy({
      liveSet,
      mode: all === true ? 'all' : 'default',
      worktree,
    })
  })

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
}): Effect.Effect<Array<CollectedWorktree>, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
    const isWorktree = yield* fs.exists(gitPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (isWorktree === true) {
      return [
        {
          ref: currentPath.slice(refTypePath.length).replace(/\/$/, ''),
          refType,
          path: currentPath,
          broken: false,
        },
      ]
    }

    const entries = yield* fs.readDirectory(currentPath)
    const result: Array<CollectedWorktree> = []

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

    /** If no worktrees found and this isn't the refType root, it's a broken worktree */
    if (result.length === 0 && currentPath !== refTypePath) {
      return [
        {
          ref: currentPath.slice(refTypePath.length).replace(/\/$/, ''),
          refType,
          path: currentPath,
          broken: true,
        },
      ]
    }

    return result
  })

const collectRepoStoreWorktrees = ({
  fs,
  repoPath,
  bareRepoPath,
}: {
  fs: FileSystem.FileSystem
  repoPath: AbsoluteDirPath
  bareRepoPath: AbsoluteDirPath
}) =>
  Effect.gen(function* () {
    const repoPrefix = repoPath.replace(/\/+$/, '')
    const refsPrefix = `${repoPrefix}/refs/`
    const realRepoPrefix = yield* fs.realPath(repoPath).pipe(
      Effect.map((path) => path.replace(/\/+$/, '')),
      Effect.catchAll(() => Effect.succeed(repoPrefix)),
    )
    const realRefsPrefix = `${realRepoPrefix}/refs/`
    const result: Array<CollectedWorktree> = []
    const seenPaths = new Set<string>()

    const gitWorktreesResult = yield* Git.listWorktrees(bareRepoPath).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan('store.git_worktree_list.failed', true)
          yield* Effect.logWarning('Falling back to store layout worktree discovery').pipe(
            Effect.annotateLogs({
              repoPath,
              bareRepoPath,
              error: error instanceof Error === true ? error.message : String(error),
            }),
          )
        }),
      ),
      Effect.either,
    )

    if (gitWorktreesResult._tag === 'Right') {
      for (const worktree of gitWorktreesResult.right) {
        const normalizedPath = worktree.path.replace(/\/+$/, '')
        const relativePath =
          normalizedPath.startsWith(refsPrefix) === true
            ? normalizedPath.slice(refsPrefix.length)
            : normalizedPath.startsWith(realRefsPrefix) === true
              ? normalizedPath.slice(realRefsPrefix.length)
              : undefined
        if (relativePath === undefined) continue

        const separatorIndex = relativePath.indexOf('/')
        if (separatorIndex === -1) continue

        const refType = relativePath.slice(0, separatorIndex)
        if (refType !== 'heads' && refType !== 'tags' && refType !== 'commits') continue

        const ref = relativePath.slice(separatorIndex + 1)
        if (ref.length === 0) continue

        seenPaths.add(normalizedPath)
        seenPaths.add(`${repoPrefix}/refs/${relativePath}`)
        result.push({
          ref,
          refType,
          path: EffectPath.unsafe.absoluteDir(`${repoPrefix}/refs/${relativePath}/`),
          broken: false,
        })
      }
    }

    for (const refType of STORE_REF_TYPES) {
      const refTypePath = EffectPath.ops.join(
        repoPath,
        EffectPath.unsafe.relativeDir(`refs/${refType}/`),
      )
      const refTypeStat = yield* fs
        .stat(refTypePath)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (refTypeStat?.type !== 'Directory') continue

      const layoutWorktrees = yield* collectStoreWorktrees({
        fs,
        refTypePath,
        currentPath: refTypePath,
        refType,
      })

      for (const worktree of layoutWorktrees) {
        const normalizedPath = worktree.path.replace(/\/+$/, '')
        if (seenPaths.has(normalizedPath) === true) continue

        seenPaths.add(normalizedPath)
        result.push(worktree)
      }
    }

    return result
  }).pipe(
    Effect.withSpan('megarepo/store/gc/collect-worktrees', {
      attributes: {
        'span.label': repoPath,
        'store.repo.path': repoPath,
        'store.bare_repo.path': bareRepoPath,
      },
    }),
  )

const classifyGcWorktree = ({
  worktree,
  liveSet,
  all,
}: {
  worktree: CollectedWorktree
  liveSet: StoreLiveSet
  all: boolean
}) =>
  Effect.gen(function* () {
    const policy = classifyStoreWorktreePolicy({
      liveSet,
      mode: all === true ? 'all' : 'default',
      worktree,
    })
    if (policy.isProtected === true) {
      return {
        worktree,
        action: 'skipped_in_use' as const,
        ...(policy.message !== undefined ? { message: policy.message } : {}),
      }
    }

    /** Broken worktrees have no .git — skip git status, proceed directly to removal. */
    if (worktree.broken === true) {
      return {
        worktree,
        action: 'check' as const,
        status: { isDirty: false, hasUnpushed: false, changesCount: 0 },
      }
    }

    const statusResult = yield* Git.getWorktreeRemovalStatus(worktree.path).pipe(
      Effect.map((status) => ({ _tag: 'status' as const, status })),
      Effect.catchAll((error) =>
        Effect.succeed({
          _tag: 'status_failed' as const,
          message: error instanceof Error === true ? error.message : String(error),
        }),
      ),
    )
    if (statusResult._tag === 'status_failed') {
      return {
        worktree,
        action: 'status_failed' as const,
        message: statusResult.message,
      }
    }

    return { worktree, action: 'check' as const, status: statusResult.status }
  }).pipe(
    Effect.withSpan('megarepo/store/gc/classify-worktree', {
      attributes: {
        'span.label': `${worktree.refType}/${worktree.ref}`,
        'store.ref.type': worktree.refType,
        'store.worktree.broken': worktree.broken,
      },
    }),
  )

/** List repos in the store */
const storeLsCommand = Cli.Command.make('ls', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()

    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetLs',
        basePath: store.basePath,
        repos: repos.map((r) => ({ relativePath: r.relativePath })),
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Effect.withSpan('megarepo/store/ls', { attributes: { 'span.label': 'ls' } }),
  ),
).pipe(Cli.Command.withDescription('List repositories in the store'))

/** Show store status and detect issues */
const storeStatusCommand = Cli.Command.make('status', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem

    const root = yield* findMegarepoRoot(cwd)
    const liveSet = yield* collectStoreLiveSet({
      store,
      ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
      pruneStaleRegistry: true,
      refreshCurrentWorkspace: true,
    })

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

          const allWorktrees: Array<CollectedWorktree> = []

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
            allWorktrees.map(
              ({ path: worktreePath, ref: expectedRef, refType: refTypeDir, broken }) =>
                Effect.gen(function* () {
                  const issues: StoreWorktreeIssue[] = []

                  if (bareExists === false) {
                    issues.push({
                      type: 'missing_bare',
                      severity: 'error',
                      message: '.bare/ directory not found',
                    })
                  }

                  if (broken === true) {
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

                  if (
                    classifyStoreWorktreePolicy({
                      liveSet,
                      mode: 'default',
                      worktree: {
                        refType: refTypeDir,
                        path: worktreePath,
                      },
                    }).isProtected === false
                  ) {
                    issues.push({
                      type: 'orphaned',
                      severity: 'info',
                      message: 'unrooted commit worktree; eligible for store gc when clean',
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
    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetStatus',
        basePath: store.basePath,
        repoCount: repos.length,
        worktreeCount: totalWorktreeCount,
        worktrees: worktreeStatuses,
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Effect.withSpan('megarepo/store/status', { attributes: { 'span.label': 'status' } }),
  ),
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
    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetFetch',
        basePath: store.basePath,
        results: results,
        elapsedMs: elapsed,
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Effect.withSpan('megarepo/store/fetch', { attributes: { 'span.label': 'fetch' } }),
  ),
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
      const storeLock = yield* StoreLock
      const fs = yield* FileSystem.FileSystem

      let root = Option.none<AbsoluteDirPath>()
      let liveSetForMetrics: StoreLiveSet | undefined
      let gcWarning: { type: 'not_in_megarepo' | 'only_current_megarepo' } | undefined
      let repoCount: number | undefined

      const processGcDecision = ({
        decision,
        repoRelativePath,
        bareRepoPath,
      }: {
        decision: GcWorktreeDecision
        repoRelativePath: string
        bareRepoPath: AbsoluteDirPath
      }) =>
        Effect.gen(function* () {
          const { worktree } = decision

          if (decision.action === 'skipped_in_use') {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_in_use',
              ...(decision.message !== undefined ? { message: decision.message } : {}),
            } satisfies StoreGcResult
          }

          if (decision.action === 'status_failed' && force === false) {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_dirty',
              message: `unable to inspect worktree status: ${decision.message}`,
            } satisfies StoreGcResult
          }

          if (
            decision.action === 'check' &&
            (decision.status.isDirty === true || decision.status.hasUnpushed === true) &&
            force === false
          ) {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_dirty',
              message:
                decision.status.isDirty === true
                  ? `${decision.status.changesCount} uncommitted change(s)`
                  : 'has unpushed commits',
            } satisfies StoreGcResult
          }

          if (dryRun === false) {
            const removeResult = yield* storeLock
              .withWorktreeLock(worktree.path)(
                Effect.gen(function* () {
                  const removalPolicy = yield* classifyGcProtection({
                    store,
                    currentWorkspaceRoot: root,
                    worktree,
                    all,
                  })
                  if (removalPolicy.isProtected === true) {
                    return { _tag: 'skipped_live' as const, message: removalPolicy.message }
                  }

                  yield* fs.remove(worktree.path, { recursive: true })
                  return { _tag: 'removed' as const }
                }),
              )
              .pipe(
                Effect.catchAll((error) =>
                  Effect.succeed({
                    _tag: 'error' as const,
                    message: error instanceof Error === true ? error.message : String(error),
                  }),
                ),
              )

            if (removeResult._tag === 'skipped_live') {
              return {
                repo: repoRelativePath,
                ref: worktree.ref,
                refType: worktree.refType,
                path: worktree.path,
                status: 'skipped_in_use',
                ...(removeResult.message !== undefined ? { message: removeResult.message } : {}),
              } satisfies StoreGcResult
            }

            if (removeResult._tag === 'error') {
              return {
                repo: repoRelativePath,
                ref: worktree.ref,
                refType: worktree.refType,
                path: worktree.path,
                status: 'error',
                message: removeResult.message,
              } satisfies StoreGcResult
            }
          }

          return {
            repo: repoRelativePath,
            ref: worktree.ref,
            refType: worktree.refType,
            path: worktree.path,
            status: 'removed',
          } satisfies StoreGcResult
        }).pipe(
          Effect.withSpan('megarepo/store/gc/process-worktree', {
            attributes: {
              'span.label': `${repoRelativePath}refs/${decision.worktree.refType}/${decision.worktree.ref}`,
              'store.repo': repoRelativePath,
              'store.ref.type': decision.worktree.refType,
              'store.worktree.path': decision.worktree.path,
              'store.bare_repo.path': bareRepoPath,
            },
          }),
        )

      const results: StoreGcResult[] = []
      let lastProgressResultCount = 0
      let completedRepoCount = 0
      let discoveredWorktreeCount = 0
      let activeWorktreeCount = 0
      let statusMessage: string | undefined = 'preparing store gc'

      const dispatchGc = ({
        done,
        forceDispatch = false,
      }: {
        done: boolean
        forceDispatch?: boolean
      }) =>
        Effect.sync(() => {
          if (
            forceDispatch === false &&
            done === false &&
            results.length - lastProgressResultCount < GC_PROGRESS_BATCH_SIZE
          ) {
            return
          }
          lastProgressResultCount = results.length
          const dispatch = tuiDispatch
          if (dispatch === undefined) return
          dispatch(
            toStoreGcAction({
              basePath: store.basePath,
              results,
              dryRun,
              warning: gcWarning,
              force,
              repoCount,
              completedRepoCount,
              discoveredWorktreeCount,
              activeWorktreeCount,
              statusMessage,
              done,
            }),
          )
        })

      let tuiDispatch: ((action: StoreAction) => void) | undefined

      const executeGc = ({ progressive }: { progressive: boolean }) =>
        Effect.gen(function* () {
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
            yield* Stream.fromSchedule(Schedule.spaced('1 second')).pipe(
              Stream.runForEach(() => dispatchGc({ done: false, forceDispatch: true })),
              Effect.forkScoped,
            )
          }

          statusMessage = 'collecting liveness registry'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }
          root = yield* findMegarepoRoot(cwd)
          const liveSet = yield* collectStoreLiveSet({
            store,
            ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
            pruneStaleRegistry: dryRun === false,
            refreshCurrentWorkspace: dryRun === false,
          })
          liveSetForMetrics = liveSet

          gcWarning =
            all === false && Option.isNone(root) === true
              ? { type: 'not_in_megarepo' }
              : all === false && Option.isSome(root) === true
                ? { type: 'only_current_megarepo' }
                : undefined

          statusMessage = 'listing store repositories'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }
          const repos = yield* store.listRepos()
          repoCount = repos.length
          statusMessage = 'checking worktrees'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }

          yield* Stream.fromIterable(repos).pipe(
            Stream.mapEffect(
              (repo) =>
                Effect.gen(function* () {
                  let removedForRepo = 0
                  const bareRepoPath = EffectPath.ops.join(
                    repo.fullPath,
                    EffectPath.unsafe.relativeDir('.bare/'),
                  )
                  const worktrees = yield* collectRepoStoreWorktrees({
                    fs,
                    repoPath: repo.fullPath,
                    bareRepoPath,
                  })

                  yield* Stream.fromIterable(worktrees).pipe(
                    Stream.mapEffect(
                      (worktree) =>
                        Effect.gen(function* () {
                          discoveredWorktreeCount += 1
                          activeWorktreeCount += 1
                          if (progressive === true) {
                            yield* dispatchGc({ done: false, forceDispatch: true })
                          }
                          yield* Effect.gen(function* () {
                            const decision = yield* classifyGcWorktree({
                              worktree,
                              liveSet,
                              all,
                            })
                            const result = yield* processGcDecision({
                              decision,
                              repoRelativePath: repo.relativePath,
                              bareRepoPath,
                            })
                            if (result.status === 'removed' && dryRun === false) {
                              removedForRepo += 1
                            }
                            results.push(result)
                          }).pipe(
                            Effect.ensuring(
                              Effect.sync(() => {
                                activeWorktreeCount -= 1
                              }).pipe(
                                Effect.zipRight(
                                  progressive === true
                                    ? dispatchGc({ done: false, forceDispatch: true })
                                    : Effect.void,
                                ),
                              ),
                            ),
                          )
                        }),
                      { concurrency: GC_WORKTREE_CONCURRENCY, unordered: true },
                    ),
                    Stream.runDrain,
                  )

                  if (removedForRepo > 0) {
                    yield* Git.pruneWorktrees(bareRepoPath).pipe(
                      Effect.catchAll((error) =>
                        Effect.sync(() => {
                          results.push({
                            repo: repo.relativePath,
                            ref: '.bare',
                            refType: 'commits',
                            path: bareRepoPath,
                            status: 'error',
                            message:
                              error instanceof Error === true ? error.message : String(error),
                          })
                        }),
                      ),
                    )
                  }

                  completedRepoCount += 1
                  if (progressive === true) {
                    yield* dispatchGc({ done: false, forceDispatch: true })
                  }
                }).pipe(
                  Effect.withSpan('megarepo/store/gc/repo', {
                    attributes: {
                      'span.label': repo.relativePath,
                      'store.repo': repo.relativePath,
                    },
                  }),
                ),
              { concurrency: GC_REPO_CONCURRENCY, unordered: true },
            ),
            Stream.runDrain,
          )

          statusMessage = undefined
          if (progressive === true) {
            yield* dispatchGc({ done: true, forceDispatch: true })
          }
        })

      const mode = yield* OutputModeTag.pipe(Effect.provide(outputModeLayer(output as never)))

      if (mode._tag === 'json' && mode.timing === 'final') {
        yield* executeGc({ progressive: false })
        yield* runStoreCommand({
          output,
          action: toStoreGcAction({
            basePath: store.basePath,
            results,
            dryRun,
            warning: gcWarning,
            force,
            repoCount,
            completedRepoCount,
            discoveredWorktreeCount,
            activeWorktreeCount,
            statusMessage,
            done: true,
          }),
        })
      } else {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.gen(function* () {
              tuiDispatch = tui.dispatch
              yield* executeGc({ progressive: true })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output as never)))
      }

      yield* Effect.annotateCurrentSpan('gc.policy', all === true ? 'all' : 'root-set')
      yield* Effect.annotateCurrentSpan(
        'gc.root_set.workspace_count',
        liveSetForMetrics?.workspaceCount ?? 0,
      )
      yield* Effect.annotateCurrentSpan('gc.repo.total', repoCount ?? 0)
      yield* Effect.annotateCurrentSpan('gc.worktree.discovered', discoveredWorktreeCount)
      yield* Effect.annotateCurrentSpan('gc.result.total', results.length)
      yield* Effect.annotateCurrentSpan(
        'gc.result.removed',
        results.filter((result) => result.status === 'removed').length,
      )
      yield* Effect.annotateCurrentSpan(
        'gc.result.skipped_in_use',
        results.filter((result) => result.status === 'skipped_in_use').length,
      )
      yield* Effect.annotateCurrentSpan(
        'gc.result.skipped_dirty',
        results.filter((result) => result.status === 'skipped_dirty').length,
      )
      yield* Effect.annotateCurrentSpan(
        'gc.candidate.commits',
        results.filter((result) => result.refType === 'commits').length,
      )
      yield* Effect.annotateCurrentSpan(
        'gc.candidate.named_refs',
        results.filter((result) => result.refType === 'heads' || result.refType === 'tags').length,
      )
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/store/gc', {
        root: true,
        attributes: {
          'span.label': 'gc',
          'gc.dry_run': dryRun,
          'gc.force': force,
          'gc.all': all,
        },
      }),
    ),
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
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/store/add', { attributes: { 'span.label': sourceString } }),
    ),
).pipe(Cli.Command.withDescription('Add a repository to the store (without adding to megarepo)'))

/** Fix store issues */
const storeFixCommand = Cli.Command.make(
  'fix',
  {
    output: outputOption,
    member: Cli.Args.text({ name: 'member' }).pipe(
      Cli.Args.withDescription('Member to fix (optional, fixes all if omitted)'),
      Cli.Args.optional,
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be fixed without making changes'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, member, dryRun }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store

      const root = yield* findMegarepoRoot(cwd)
      if (Option.isNone(root) === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_in_megarepo',
                message: 'Not in a megarepo directory. Run this command from within a megarepo.',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Not in a megarepo' })
      }

      const { config } = yield* readMegarepoConfig(root.value)

      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      if (Option.isNone(lockFileOpt) === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'no_lock',
                message: 'No megarepo.lock found. Run `mr fetch` first.',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'No lock file' })
      }

      const lockFile = lockFileOpt.value

      // Determine which members to check
      const memberNames =
        Option.isSome(member) === true ? [member.value] : Object.keys(config.members)

      // Validate
      const issues = yield* validateStoreMembers({
        memberNames,
        config,
        lockFile,
        store,
      })

      if (issues.length === 0) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetFix',
                basePath: store.basePath,
                results: [],
                dryRun,
                noIssues: true,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return
      }

      // Fix issues
      const results = yield* fixStoreIssues({ issues, store, dryRun })

      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetFix',
              basePath: store.basePath,
              results,
              dryRun,
              noIssues: false,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/store/fix', { attributes: { 'span.label': 'fix' } }),
    ),
).pipe(Cli.Command.withDescription('Fix store issues'))

/**
 * Create a new worktree in the store.
 * Auto-bootstraps bare repo if not present, fetches, then creates the worktree.
 */
const storeWorktreeNewCommand = Cli.Command.make(
  'new',
  {
    repo: Cli.Args.text({ name: 'repo' }).pipe(
      Cli.Args.withDescription('Repository (owner/repo, URL, or store-relative path)'),
    ),
    ref: Cli.Options.text('ref').pipe(
      Cli.Options.withDescription('Branch or tag name to check out'),
      Cli.Options.optional,
    ),
    base: Cli.Options.text('base').pipe(
      Cli.Options.withDescription('Base ref for creating a new branch (used with --ref)'),
      Cli.Options.optional,
    ),
    commit: Cli.Options.text('commit').pipe(
      Cli.Options.withDescription('Commit SHA to check out (detached HEAD)'),
      Cli.Options.optional,
    ),
    porcelain: Cli.Options.boolean('porcelain').pipe(
      Cli.Options.withDescription(
        'Output only the worktree path for scripting (e.g. cd $(mr store worktree new ... --porcelain))',
      ),
      Cli.Options.withDefault(false),
    ),
    output: outputOption,
  },
  ({ repo: repoString, ref: refOpt, base: baseOpt, commit: commitOpt, porcelain, output }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      const ref = Option.getOrUndefined(refOpt)
      const base = Option.getOrUndefined(baseOpt)
      const commit = Option.getOrUndefined(commitOpt)

      // Validate: must specify --ref or --commit, not both
      if (ref === undefined && commit === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'missing_ref',
                message: 'Must specify --ref <branch|tag> or --commit <sha>',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Must specify --ref or --commit' })
      }

      if (ref !== undefined && commit !== undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'conflicting_options',
                message: 'Cannot specify both --ref and --commit',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot specify both --ref and --commit' })
      }

      if (base !== undefined && ref === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'base_without_ref',
                message: '--base requires --ref to specify the new branch name',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({
          message: '--base requires --ref',
        })
      }

      // Parse repo source
      const source = parseSourceString(repoString)
      if (source === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'invalid_source',
                message: `Invalid repository: ${repoString}`,
                source: repoString,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Invalid repository' })
      }

      if (isRemoteSource(source) === false) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'local_path',
                message: 'Cannot create worktree for local path',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot use local path' })
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

      // Auto-bootstrap: clone bare repo if not in store
      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* store.hasBareRepo(source)
      const autoBootstrap = bareExists === false

      if (autoBootstrap === true) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
      }

      // Fetch to ensure refs are up to date
      yield* Git.fetchBare({ repoPath: bareRepoPath })

      // Determine target ref and worktree creation mode
      const targetRef = commit ?? ref!
      const isNewBranch = base !== undefined
      const refType = commit !== undefined ? ('commit' as const) : classifyRef(targetRef)

      // Compute worktree path
      const worktreePath = store.getWorktreePath({ source, ref: targetRef, refType })

      // Fail if worktree already exists
      const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef, refType })
      if (worktreeExists === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'worktree_exists',
                message: `Worktree already exists at ${worktreePath}`,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({
          message: `Worktree already exists at ${worktreePath}`,
        })
      }

      // Create parent directory
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create the worktree
      if (commit !== undefined) {
        // Detached HEAD at specific commit
        yield* Git.createWorktreeDetached({
          repoPath: bareRepoPath,
          worktreePath,
          commit,
        })
      } else if (isNewBranch === true) {
        // New branch from base
        yield* Git.createWorktree({
          repoPath: bareRepoPath,
          worktreePath,
          branch: ref!,
          createBranch: true,
          startPoint: base,
        })
      } else {
        // Existing branch or tag
        if (refType === 'tag') {
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
      // Get the current commit in the new worktree
      const commitSha = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
      const resolvedCommit = Option.getOrUndefined(commitSha)

      // Porcelain: raw path output for scripting (e.g. cd $(mr store worktree new ... --porcelain))
      if (porcelain === true) {
        yield* Effect.sync(() => process.stdout.write(worktreePath.replace(/\/$/, '') + '\n'))
        return
      }

      // Output
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetWorktreeNew',
              source: repoString,
              ref: targetRef,
              path: worktreePath,
              commit: resolvedCommit,
              autoBootstrap,
              branchCreated: isNewBranch,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/store/worktree/new', {
        attributes: { 'span.label': repoString },
      }),
    ),
).pipe(Cli.Command.withDescription('Create a new worktree in the store'))

/** Worktree subcommand group */
const storeWorktreeCommand = Cli.Command.make('worktree', {}).pipe(
  Cli.Command.withSubcommands([storeWorktreeNewCommand]),
  Cli.Command.withDescription('Manage worktrees in the store'),
)

/** Store subcommand group */
export const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([
    storeAddCommand,
    storeLsCommand,
    storeStatusCommand,
    storeFetchCommand,
    storeGcCommand,
    storeFixCommand,
    storeWorktreeCommand,
  ]),
  Cli.Command.withDescription('Manage the shared git store'),
)
