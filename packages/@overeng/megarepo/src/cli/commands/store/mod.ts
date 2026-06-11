/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import * as Cli from '@effect/cli'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Clock, Effect, Option, Schedule, Stream } from 'effect'
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
import { archiveWorktree, reapArchive, scanArchives } from '../../../lib/store-archive.ts'
import { loadStoreGcConfig, type StoreGcConfig } from '../../../lib/store-gc-config.ts'
import {
  coldSinceMs as coldSinceMsFor,
  recordObservations,
} from '../../../lib/store-gc-observations.ts'
import { validateStoreMembers, fixStoreIssues } from '../../../lib/store-hygiene.ts'
import {
  collectStoreLiveSet,
  isPathProtected,
  type StoreLiveSet,
} from '../../../lib/store-liveness.ts'
import { StoreLock } from '../../../lib/store-lock.ts'
import { assessLossless } from '../../../lib/store-lossless.ts'
import {
  makePrStateResolverLayer,
  PrStateResolver,
  type PrStateInfo,
  type PrStateResolverService,
} from '../../../lib/store-pr-state.ts'
import {
  classifyColdWorktree,
  isNamedRefWorktree,
  type ColdWorktreeDecision,
} from '../../../lib/store-worktree-policy.ts'
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

    // Git's worktree registry can be stale or incomplete after interrupted
    // operations. Use it as a fast hint, then merge in the path layout because
    // the store layout is the durable source of truth for refs/heads|tags|commits.
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

const normalizeStorePath = (path: string): string => path.replace(/\/+$/, '')

/** A named (`refs/heads/*`) worktree paired with the repo it belongs to. */
interface NamedWorktreeTarget {
  readonly repoRelativePath: string
  readonly repoFullPath: AbsoluteDirPath
  readonly bareRepoPath: AbsoluteDirPath
  readonly worktree: CollectedWorktree
}

/**
 * Build a `StoreGcResult` for a cold-path outcome.
 *
 * `reason` is the stable classification tag (live/not-stale/merged/...);
 * `message` carries free-form detail; `recoverPath` is the `.archive/` location
 * for an archived worktree.
 */
const coldResult = ({
  target,
  status,
  reason,
  message,
  recoverPath,
}: {
  target: NamedWorktreeTarget
  status: StoreGcResult['status']
  reason?: string | undefined
  message?: string | undefined
  recoverPath?: string | undefined
}): StoreGcResult => ({
  repo: target.repoRelativePath,
  ref: target.worktree.ref,
  refType: target.worktree.refType,
  path: target.worktree.path,
  status,
  ...(reason !== undefined ? { reason } : {}),
  ...(message !== undefined ? { message } : {}),
  ...(recoverPath !== undefined ? { recoverPath } : {}),
})

/**
 * Re-derive a fresh live set under lock for the veto re-check (invariant 1).
 *
 * Reconciles every present workspace again so a worktree that became live
 * between the initial collect and this destructive step is never archived/reaped.
 * Read-only with respect to the on-disk records here? No — reconcile rewrites
 * records, so it is serialized by the caller's `withWorktreeLock`.
 */
const reReconcileLiveSet = ({
  store,
  root,
  now,
}: {
  store: Effect.Effect.Success<typeof Store>
  root: Option.Option<AbsoluteDirPath>
  now: number
}) =>
  collectStoreLiveSet({
    store,
    ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
    refreshCurrentWorkspace: false,
    pruneStaleRegistry: false,
    reconcileAllWorkspaces: true,
    now,
  })

/**
 * Cold reclamation for ONE repo's named worktrees (decisions 0001–0010).
 *
 * Fetch the bare first (failure ⇒ keep ALL this repo's named worktrees — the
 * reachability signal would be stale). Then per named worktree: enforce the
 * actual-HEAD-branch gate (`ref_mismatch` ⇒ keep), resolve PR state adjacent to
 * classification, assess the lossless floor, and classify. An `archive` decision
 * runs under `withWorktreeLock` with a FRESH live-set veto re-check immediately
 * before `archiveWorktree` (archive → verify → free-branch is the helper's job);
 * any failure leaves the original intact and reports keep+error. Finally scan
 * `.archive/` and reap entries past the retention TTL, each under lock + veto.
 *
 * `now` is the explicit epoch-ms decision clock; `coldSince` is read from the
 * pre-recorded observation ledger so grace windows are consistent across repos.
 */
const coldReclaimRepo = ({
  store,
  storeLock,
  prResolver,
  root,
  repoRelativePath,
  repoFullPath,
  bareRepoPath,
  namedWorktrees,
  liveSet,
  ledger,
  config,
  now,
  dryRun,
}: {
  store: Effect.Effect.Success<typeof Store>
  storeLock: Effect.Effect.Success<typeof StoreLock>
  prResolver: PrStateResolverService
  root: Option.Option<AbsoluteDirPath>
  repoRelativePath: string
  repoFullPath: AbsoluteDirPath
  bareRepoPath: AbsoluteDirPath
  namedWorktrees: ReadonlyArray<NamedWorktreeTarget>
  liveSet: StoreLiveSet
  ledger: Record<string, number>
  config: StoreGcConfig
  now: number
  dryRun: boolean
}) =>
  Effect.gen(function* () {
    const results: StoreGcResult[] = []

    // Fetch --prune so `refs/remotes/*` is fresh (the reachability + PR-prune
    // signal). A repo whose fetch fails keeps ALL its named worktrees — the
    // conservative direction (every commit would read as unpushed).
    const fetchResult = yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.either)
    if (fetchResult._tag === 'Left') {
      const message =
        fetchResult.left instanceof Error === true
          ? fetchResult.left.message
          : String(fetchResult.left)
      for (const target of namedWorktrees) {
        results.push(coldResult({ target, status: 'kept', reason: 'fetch-failed', message }))
      }
      return results
    }

    for (const target of namedWorktrees) {
      const { worktree } = target
      // Only `refs/heads/*` carries a branch identity to reclaim; tags have no
      // PR/branch to free, so they are always kept by the cold path.
      if (worktree.refType !== 'heads') {
        results.push(coldResult({ target, status: 'kept', reason: 'named-tag-ref' }))
        continue
      }

      // ref_mismatch gate: the store path claims `<ref>` but the worktree HEAD is
      // on a different branch. Archiving frees `refs/heads/<ref>`, which is NOT
      // the branch actually checked out — keep and surface the divergence.
      const headBranch = yield* Git.getCurrentBranch(worktree.path).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      if (Option.isSome(headBranch) === true && headBranch.value !== worktree.ref) {
        results.push(
          coldResult({
            target,
            status: 'kept',
            reason: 'ref_mismatch',
            message: `HEAD is '${headBranch.value}'`,
          }),
        )
        continue
      }

      const prState: PrStateInfo = yield* prResolver.resolve({
        relativePath: EffectPath.unsafe.relativeDir(target.repoRelativePath),
        branch: worktree.ref,
      })

      const head = yield* Git.getCurrentCommit(worktree.path).pipe(
        Effect.map(Option.some),
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      if (Option.isNone(head) === true) {
        results.push(coldResult({ target, status: 'kept', reason: 'unreadable-head' }))
        continue
      }
      const worktreeHead = head.value

      const lossless = yield* assessLossless({
        bareRepoPath,
        worktreePath: worktree.path,
        worktreeHead,
      }).pipe(
        Effect.map(Option.some),
        // A failed lossless probe (e.g. unresolvable head) degrades to keep.
        Effect.catchAll(() => Effect.succeed(Option.none<never>())),
      )
      if (Option.isNone(lossless) === true) {
        results.push(coldResult({ target, status: 'kept', reason: 'unrecoverable-local-work' }))
        continue
      }

      const decision: ColdWorktreeDecision = classifyColdWorktree({
        worktree: { refType: 'heads', path: worktree.path },
        liveSet,
        prState,
        lossless: lossless.value,
        coldSinceMs: coldSinceMsFor({ ledger, path: worktree.path }),
        config,
        now,
      })

      if (decision._tag === 'keep') {
        results.push(coldResult({ target, status: 'kept', reason: decision.reason }))
        continue
      }

      // Archive decision: serialize under the worktree lock and re-check the live
      // veto against a FRESH reconcile immediately before moving (invariant 1).
      if (dryRun === true) {
        results.push(coldResult({ target, status: 'archived', reason: decision.reason }))
        continue
      }

      const archiveOutcome = yield* storeLock
        .withWorktreeLock(worktree.path)(
          Effect.gen(function* () {
            const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
            if (isPathProtected({ liveSet: freshLiveSet, path: worktree.path }) === true) {
              return { _tag: 'kept-live' as const }
            }
            const outcome = yield* archiveWorktree({
              repoRoot: repoFullPath,
              bareRepoPath,
              worktreePath: worktree.path,
              branch: worktree.ref,
              commit: worktreeHead,
              reason: decision.reason,
              now,
            })
            return {
              _tag: 'archived' as const,
              recoverPath: outcome.destPath,
              warnings: outcome.warnings,
            }
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

      if (archiveOutcome._tag === 'kept-live') {
        results.push(coldResult({ target, status: 'kept', reason: 'live' }))
      } else if (archiveOutcome._tag === 'error') {
        // Only a PRE-move failure reaches here (post-move steps are best-effort
        // and reported as warnings, never errors), so the original worktree is
        // genuinely left intact.
        results.push(
          coldResult({
            target,
            status: 'error',
            reason: decision.reason,
            message: archiveOutcome.message,
          }),
        )
      } else {
        // The move succeeded: report `archived` + the real `.archive/` recovery
        // path even if a best-effort post-move step (branch free / README) failed.
        results.push(
          coldResult({
            target,
            status: 'archived',
            reason: decision.reason,
            recoverPath: archiveOutcome.recoverPath,
            ...(archiveOutcome.warnings.length > 0
              ? { message: archiveOutcome.warnings.join('; ') }
              : {}),
          }),
        )
      }
    }

    // Reap archives past the retention TTL, each under lock + a fresh veto.
    const archives = yield* scanArchives({ repoRoot: repoFullPath, bareRepoPath }).pipe(
      Effect.catchAll(() => Effect.succeed([] as never[])),
    )
    for (const entry of archives) {
      if (now - entry.archivedAtMs < config.archiveRetentionMs) continue

      const reapTarget: NamedWorktreeTarget = {
        repoRelativePath,
        repoFullPath,
        bareRepoPath,
        worktree: {
          ref: entry.branch,
          refType: 'heads',
          path: entry.path,
          broken: false,
        },
      }

      if (dryRun === true) {
        results.push(coldResult({ target: reapTarget, status: 'reaped', reason: 'retention' }))
        continue
      }

      const reapOutcome = yield* storeLock
        .withWorktreeLock(entry.path)(
          Effect.gen(function* () {
            const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
            if (isPathProtected({ liveSet: freshLiveSet, path: entry.path }) === true) {
              return { _tag: 'kept-live' as const }
            }
            yield* reapArchive({ bareRepoPath, path: entry.path })
            return { _tag: 'reaped' as const }
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

      if (reapOutcome._tag === 'kept-live') {
        results.push(coldResult({ target: reapTarget, status: 'kept', reason: 'live' }))
      } else if (reapOutcome._tag === 'error') {
        results.push(
          coldResult({
            target: reapTarget,
            status: 'error',
            reason: 'retention',
            message: reapOutcome.message,
          }),
        )
      } else {
        results.push(coldResult({ target: reapTarget, status: 'reaped', reason: 'retention' }))
      }
    }

    return results
  }).pipe(
    Effect.withSpan('megarepo/store/gc/cold-reclaim-repo', {
      attributes: {
        'span.label': repoRelativePath,
        'store.repo': repoRelativePath,
        'store.bare_repo.path': bareRepoPath,
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
    const now = yield* Clock.currentTimeMillis
    const liveSet = yield* collectStoreLiveSet({
      store,
      ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
      pruneStaleRegistry: true,
      refreshCurrentWorkspace: true,
      now,
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

          // Single decision clock for the whole run — every grace/retention/
          // persistence path reads THIS value, never the ambient wall clock again.
          const now = yield* Clock.currentTimeMillis

          statusMessage = 'collecting liveness registry'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }
          root = yield* findMegarepoRoot(cwd)
          // Default cold path reconciles EVERY present workspace once (decision
          // 0010) so a repin that ran no refreshing command is still caught; the
          // result is threaded everywhere. `--all` keeps its lighter collect.
          const liveSet = yield* collectStoreLiveSet({
            store,
            ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
            pruneStaleRegistry: dryRun === false,
            refreshCurrentWorkspace: dryRun === false,
            ...(all === false ? { reconcileAllWorkspaces: true } : {}),
            now,
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

          // Per-repo collected worktrees, computed once so the default cold path
          // can record observations globally (ledger replaces, not merges) before
          // any per-repo classification.
          const repoWorktrees = yield* Effect.all(
            repos.map((repo) =>
              Effect.gen(function* () {
                const bareRepoPath = EffectPath.ops.join(
                  repo.fullPath,
                  EffectPath.unsafe.relativeDir('.bare/'),
                )
                const worktrees = yield* collectRepoStoreWorktrees({
                  fs,
                  repoPath: repo.fullPath,
                  bareRepoPath,
                })
                return { repo, bareRepoPath, worktrees }
              }),
            ),
            { concurrency: GC_REPO_CONCURRENCY },
          )

          // Default cold reclamation path (decisions 0001–0010): additive third
          // path. Named (`refs/heads/*`/`refs/tags/*`) worktrees are owned here;
          // `--all` removes everything via the legacy stream and skips this.
          if (all === false) {
            const namedTargets: Array<NamedWorktreeTarget> = []
            for (const { repo, bareRepoPath, worktrees } of repoWorktrees) {
              for (const worktree of worktrees) {
                if (worktree.broken === true) continue
                if (isNamedRefWorktree(worktree) === false) continue
                namedTargets.push({
                  repoRelativePath: repo.relativePath,
                  repoFullPath: repo.fullPath,
                  bareRepoPath,
                  worktree,
                })
              }
            }

            // Cold = a named worktree absent from the reconciled live set. Record
            // the FULL cold set ONCE (the ledger is store-global; a per-repo write
            // would launder other repos' grace). Unclean-reconcile paths re-arm.
            const coldPaths = namedTargets
              .filter(
                (target) => isPathProtected({ liveSet, path: target.worktree.path }) === false,
              )
              .map((target) => normalizeStorePath(target.worktree.path))
            // The ledger read-modify-write is store-global; serialize it under a
            // stable store-keyed lock so concurrent gc runs don't clobber it.
            const ledger = yield* storeLock.withWorktreeLock(
              `${store.basePath}.state/gc-observations`,
            )(
              recordObservations({
                storeBasePath: store.basePath,
                coldPaths,
                uncleanReconcilePaths: [...liveSet.uncleanReconcilePaths],
                now,
              }),
            )

            const config = yield* loadStoreGcConfig({ storeBasePath: store.basePath })

            // Use an injected `PrStateResolver` when present (tests provide a stub
            // layer); otherwise build the live `gh`-shelling resolver here so the
            // default `mr store gc` path needs no extra wiring at the CLI edge.
            const injectedResolver = yield* Effect.serviceOption(PrStateResolver)
            const prResolver =
              Option.isSome(injectedResolver) === true
                ? injectedResolver.value
                : yield* PrStateResolver.pipe(Effect.provide(makePrStateResolverLayer()))

            statusMessage = 'reclaiming cold worktrees'
            if (progressive === true) {
              yield* dispatchGc({ done: false, forceDispatch: true })
            }

            // Group named targets by repo, then reclaim per repo (concurrency 1 so
            // a global PR snapshot can never go stale — resolve adjacent instead).
            yield* Stream.fromIterable(repoWorktrees).pipe(
              Stream.mapEffect(
                ({ repo, bareRepoPath }) =>
                  Effect.gen(function* () {
                    const repoNamed = namedTargets.filter(
                      (target) => target.repoRelativePath === repo.relativePath,
                    )
                    if (repoNamed.length === 0) return
                    discoveredWorktreeCount += repoNamed.length
                    activeWorktreeCount += repoNamed.length
                    if (progressive === true) {
                      yield* dispatchGc({ done: false, forceDispatch: true })
                    }
                    const repoResults = yield* coldReclaimRepo({
                      store,
                      storeLock,
                      prResolver,
                      root,
                      repoRelativePath: repo.relativePath,
                      repoFullPath: repo.fullPath,
                      bareRepoPath,
                      namedWorktrees: repoNamed,
                      liveSet,
                      ledger,
                      config,
                      now,
                      dryRun,
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          activeWorktreeCount -= repoNamed.length
                        }),
                      ),
                    )
                    for (const result of repoResults) results.push(result)
                    if (progressive === true) {
                      yield* dispatchGc({ done: false, forceDispatch: true })
                    }
                  }),
                { concurrency: GC_REPO_CONCURRENCY, unordered: true },
              ),
              Stream.runDrain,
            )
          }

          yield* Stream.fromIterable(repoWorktrees).pipe(
            Stream.mapEffect(
              ({ repo, bareRepoPath, worktrees: allWorktrees }) =>
                Effect.gen(function* () {
                  let removedForRepo = 0
                  // Default mode owns named worktrees in the cold path above; the
                  // legacy stream only handles commit worktrees (and everything in
                  // `--all` mode).
                  const worktrees =
                    all === false
                      ? allWorktrees.filter(
                          (worktree) =>
                            worktree.broken === true || isNamedRefWorktree(worktree) === false,
                        )
                      : allWorktrees

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

      // Final JSON callers want one stable document, not progress states. Run the
      // GC first and serialize only the final StoreApp state.
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
