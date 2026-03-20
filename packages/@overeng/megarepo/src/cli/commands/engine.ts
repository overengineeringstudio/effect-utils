/**
 * Megarepo Sync Engine
 *
 * Core sync logic shared by all three commands (fetch, apply, lock).
 * - `syncMegarepo` — recursive megarepo sync parameterized by mode
 * - `runCommand` — CLI orchestration: TUI rendering, fetch-before-apply, error merging
 */

import { Prompt } from '@effect/cli'
import type { CommandExecutor, Terminal } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import {
  type ConfigNotFoundError,
  findConfigPath,
  getMemberPath,
  getMembersRoot,
  getSourceUrl,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
} from '../../lib/config.ts'
import { generateAll, getEnabledGenerators } from '../../lib/generators/mod.ts'
import * as Git from '../../lib/git.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  LOCK_FILE_NAME,
  readLockFile,
  syncLockWithConfig,
  upsertLockedMember,
  writeLockFile,
} from '../../lib/lock.ts'
import { syncNixLocks, type NixLockSyncResult } from '../../lib/nix-lock/mod.ts'
import { runPreflightChecks, type StoreHygieneError } from '../../lib/store-hygiene.ts'
import { Store, StoreLayer } from '../../lib/store.ts'
import {
  type GitProtocol,
  makeRepoSemaphoreMap,
  type MissingRefAction,
  type MissingRefInfo,
  collectSyncErrors,
  syncMember,
  type MegarepoSyncResult,
  type MemberSyncResult,
  type SyncMode,
} from '../../lib/sync/mod.ts'
import type { MegarepoSyncTree as MegarepoSyncTreeType } from '../../lib/sync/schema.ts'
import { Cwd, findMegarepoRoot, outputModeLayer, type OutputModeValue } from '../context.ts'
import {
  NotInMegarepoError,
  LockFileRequiredError,
  StaleLockFileError,
  InvalidOptionsError,
} from '../errors.ts'
import {
  SyncApp,
  SyncView,
  startSyncUI,
  finishSyncUI,
  isTTY,
  type SyncUIHandle,
} from '../renderers/SyncOutput/mod.ts'
import type {
  MemberLockSyncResult,
  LockSharedSourceUpdate,
  SyncAction,
} from '../renderers/SyncOutput/schema.ts'

/**
 * Sync a megarepo at the given root path.
 * This is extracted to enable recursive syncing for --all mode.
 *
 * @param visited - Set of already-synced megarepo roots (resolved paths) to prevent duplicate syncing
 *                  in diamond dependency scenarios (e.g., A→B, A→C, B→D, C→D where D would be synced twice)
 * @param withProgress - When true, uses limited concurrency (4) for visible progress updates
 */
export const syncMegarepo = <R = never>({
  megarepoRoot,
  options,
  depth = 0,
  visited = new Set<string>(),
  progressHandle,
  onMissingRef,
}: {
  megarepoRoot: AbsoluteDirPath
  options: {
    mode: SyncMode
    dryRun: boolean
    force: boolean
    all: boolean
    only: ReadonlyArray<string> | undefined
    skip: ReadonlyArray<string> | undefined
    gitProtocol: GitProtocol
    createBranches: boolean
    /** When true (fetch --apply), skip staleness check and run fetch before apply for nested --all recursion. */
    applyAfterFetch?: boolean
    /** When true, use commit-based worktrees (refs/commits/<sha>) for deterministic apply. */
    commitMode?: boolean
  }
  depth?: number
  visited?: Set<string>
  /** Handle for dispatching progress updates */
  progressHandle?: SyncUIHandle
  /** Callback for interactive prompts when a ref doesn't exist */
  onMissingRef?: (info: MissingRefInfo) => Effect.Effect<MissingRefAction, never, R>
}): Effect.Effect<
  MegarepoSyncResult,
  | NotInMegarepoError
  | LockFileRequiredError
  | StaleLockFileError
  | StoreHygieneError
  | ConfigNotFoundError
  | PlatformError.PlatformError
  | ParseResult.ParseError
  | Error,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Store | R
> =>
  Effect.gen(function* () {
    const { mode, dryRun, force, all, only, skip, gitProtocol, createBranches } = options
    const fs = yield* FileSystem.FileSystem
    const isApplyMode = mode === 'apply'
    const isFetchMode = mode === 'fetch'
    const isLockMode = mode === 'lock'
    const writesLock = isFetchMode || isLockMode
    const changesWorkspace = isApplyMode

    // Resolve to physical path for deduplication (handles symlinks)
    const resolvedRoot = yield* fs.realPath(megarepoRoot)

    // Check if we've already synced this megarepo (circuit breaker for diamond dependencies)
    if (visited.has(resolvedRoot) === true) {
      // Skip silently - duplicate syncing detected
      return {
        root: megarepoRoot,
        results: [],
        nestedMegarepos: [],
        nestedResults: [],
        lockSyncResults: undefined,
      } satisfies MegarepoSyncResult
    }

    // Mark as visited
    visited.add(resolvedRoot)

    // Load config
    const { config } = yield* readMegarepoConfig(megarepoRoot)

    if (dryRun === false) {
      const membersRoot = getMembersRoot(megarepoRoot)
      yield* fs.makeDirectory(membersRoot, { recursive: true })
    }

    // Load lock file (optional unless apply)
    const lockPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    let lockFile = Option.getOrUndefined(lockFileOpt)

    // Determine which members are remote (need lock tracking)
    const remoteMemberNames = new Set<string>()
    for (const [name, sourceString] of Object.entries(config.members)) {
      const source = parseSourceString(sourceString)
      if (source !== undefined && isRemoteSource(source) === true) {
        remoteMemberNames.add(name)
      }
    }

    // Compute which members will be skipped based on --only and --skip options
    // This is needed before the lock-apply staleness check to correctly filter member selection
    const allMemberNames = Object.keys(config.members)
    const skippedMemberNames = new Set(
      allMemberNames.filter((name) => {
        if (only !== undefined && only.length > 0) {
          return !only.includes(name)
        }
        if (skip !== undefined && skip.length > 0) {
          return skip.includes(name)
        }
        return false
      }),
    )

    // Check apply requirements — lock file must exist and not be stale.
    // Skip when applyAfterFetch is set (fetch just ran; "staleness" = fetch failures, not real drift).
    if (isApplyMode === true && options.applyAfterFetch !== true) {
      if (lockFile === undefined) {
        return yield* new LockFileRequiredError({
          message: 'Lock file required for mr apply',
        })
      }

      // When using --only or --skip, only check staleness for members we're actually syncing
      // This allows CI to skip private repos without failing the staleness check
      // We need to filter BOTH config members AND lock file members
      const filteredRemoteMemberNames = new Set(
        [...remoteMemberNames].filter((name) => !skippedMemberNames.has(name)),
      )

      // Create a filtered lock file that excludes skipped members
      const filteredLockFile = {
        ...lockFile,
        members: Object.fromEntries(
          Object.entries(lockFile.members).filter(([name]) => !skippedMemberNames.has(name)),
        ),
      }

      // Check for staleness (only for members we're syncing)
      const staleness = checkLockStaleness({
        lockFile: filteredLockFile,
        configMemberNames: filteredRemoteMemberNames,
      })
      if (staleness.isStale === true) {
        return yield* new StaleLockFileError({
          message: 'Lock file is stale for mr apply',
          addedMembers: staleness.addedMembers,
          removedMembers: staleness.removedMembers,
        })
      }
    }

    // Run pre-flight hygiene checks for write commands (lock, apply) — not fetch (read-only).
    // Skip when applyAfterFetch is set (fetch just ran; store state may have just changed).
    if (
      (isLockMode === true || isApplyMode === true) &&
      options.applyAfterFetch !== true &&
      lockFile !== undefined
    ) {
      const store = yield* Store
      const membersToCheck = allMemberNames.filter((name) => !skippedMemberNames.has(name))
      yield* runPreflightChecks({
        memberNames: membersToCheck,
        config,
        lockFile,
        store,
        mode: isApplyMode === true ? 'apply' : 'lock',
        ...(options.commitMode === true ? { commitMode: true } : {}),
      })
    }

    // Filter members based on --only and --skip options (uses pre-computed skippedMemberNames)
    const allMembers = Object.entries(config.members)
    const members = allMembers.filter(([name]) => !skippedMemberNames.has(name))

    // Create a semaphore map for serializing bare repo creation per repo URL.
    // This prevents race conditions when multiple members reference the same repo
    // (e.g., jq-latest and jq-v16 both from jqlang/jq).
    const semaphoreMap = yield* makeRepoSemaphoreMap()

    // Sync all members with limited concurrency for visible progress
    // Use unbounded for non-TTY (faster) or limited (4) for TTY (visible progress)
    const concurrency = progressHandle !== undefined ? 4 : 'unbounded'

    const results = yield* Effect.all(
      members.map(([name, sourceString]) =>
        Effect.gen(function* () {
          // Mark as syncing in progress UI
          if (progressHandle !== undefined) {
            progressHandle.dispatch({ _tag: 'SetActiveMember', name })
          }

          // Perform the sync
          const result = yield* syncMember({
            name,
            sourceString,
            megarepoRoot,
            lockFile,
            mode,
            dryRun,
            force,
            semaphoreMap,
            gitProtocol,
            createBranches,
            ...(options.commitMode === true ? { commitMode: true } : {}),
            ...(onMissingRef !== undefined ? { onMissingRef } : {}),
          })

          // Apply result to progress UI
          if (progressHandle !== undefined) {
            progressHandle.dispatch({ _tag: 'AddResult', result })
          }

          return result
        }),
      ),
      { concurrency },
    )

    // Detect and remove orphaned symlinks (members removed from config) — only in apply mode
    const membersRoot = getMembersRoot(megarepoRoot)
    const configuredMemberNames = new Set(Object.keys(config.members))
    const removedResults: Array<MemberSyncResult> = []

    // Only check for orphans in apply mode (workspace changes) and if repos/ directory exists
    const membersRootExists =
      changesWorkspace === true &&
      (yield* fs.exists(membersRoot).pipe(Effect.catchAll(() => Effect.succeed(false))))

    if (membersRootExists === true) {
      const existingEntries = yield* fs
        .readDirectory(membersRoot)
        .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

      const candidates = existingEntries.filter(
        (entry) => !configuredMemberNames.has(entry) && !skippedMemberNames.has(entry),
      )

      const orphanResults = yield* Effect.all(
        candidates.map((entry) =>
          Effect.gen(function* () {
            const entryPath = EffectPath.ops.join(
              membersRoot,
              EffectPath.unsafe.relativeFile(entry),
            )

            // Only remove symlinks (not directories that might be local repos)
            const linkTarget = yield* fs
              .readLink(entryPath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))

            if (linkTarget !== null) {
              if (dryRun === false) {
                yield* fs.remove(entryPath).pipe(Effect.catchAll(() => Effect.void))
              }
              return {
                name: entry,
                status: 'removed' as const,
                message: linkTarget,
              }
            }
            return undefined
          }),
        ),
        { concurrency: 'unbounded' },
      )

      for (const result of orphanResults) {
        if (result !== undefined) {
          removedResults.push(result)
        }
      }
    }

    // Combine results with removed members
    const allResults = [...results, ...removedResults]

    // Check which members are themselves megarepos (for --all)
    const nestedMegarepoChecks = yield* Effect.all(
      results.map((result) =>
        Effect.gen(function* () {
          if (result.status === 'error' || result.status === 'skipped') {
            return null
          }
          const memberPath = getMemberPath({ megarepoRoot, name: result.name })
          const nestedConfig = yield* findConfigPath(memberPath).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          )
          return nestedConfig !== undefined ? result.name : null
        }),
      ),
      { concurrency: 'unbounded' },
    )
    const nestedMegarepos = nestedMegarepoChecks.filter((name): name is string => name !== null)

    // Track Nix lock sync results (populated if lock sync runs)
    let nixLockResult: NixLockSyncResult | undefined = undefined

    // Update lock file in fetch and lock modes.
    if (dryRun === false && writesLock === true) {
      // Initialize lock file if needed
      if (lockFile === undefined) {
        lockFile = createEmptyLockFile()
      }

      // Sync lock with config (remove stale entries)
      lockFile = syncLockWithConfig({
        lockFile,
        configMemberNames: remoteMemberNames,
      })

      // Update lock entries from results
      for (const result of results) {
        // Only process results that have commit and ref info
        const commit = 'commit' in result === true ? result.commit : undefined
        const ref = 'ref' in result === true ? result.ref : undefined
        if (commit === undefined || ref === undefined) continue

        const sourceString = config.members[result.name]
        if (sourceString === undefined) continue
        const source = parseSourceString(sourceString)
        if (source === undefined || isRemoteSource(source) === false) continue

        const url = getSourceUrl(source) ?? sourceString
        const existingLocked = lockFile.members[result.name]

        lockFile = upsertLockedMember({
          lockFile,
          memberName: result.name,
          update: {
            url,
            ref,
            commit,
            pinned: existingLocked?.pinned ?? false,
          },
        })
      }

      // Write lock file
      yield* writeLockFile({ lockPath, lockFile })
    }

    // Nix lock sync and generators only run when changing workspace (apply mode).
    if (dryRun === false && changesWorkspace === true) {
      // Sync Nix lock files (flake.lock, devenv.lock) in member repos
      // - lockSync.enabled: true → always enable (explicit override)
      // - lockSync.enabled: false → always disable (explicit override)
      // - lockSync.enabled: undefined → auto-detect based on root lock file presence
      if (lockFile !== undefined) {
        const lockSyncFs = yield* FileSystem.FileSystem
        const lockSyncExplicitSetting = config.lockSync?.enabled
        const devenvLockExists = yield* lockSyncFs.exists(
          EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeFile('devenv.lock')),
        )
        const flakeLockExists = yield* lockSyncFs.exists(
          EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeFile('flake.lock')),
        )
        const lockSyncEnabled =
          lockSyncExplicitSetting === true ||
          (lockSyncExplicitSetting !== false && (devenvLockExists || flakeLockExists))

        if (lockSyncEnabled === true) {
          const excludeMembers = new Set(config.lockSync?.exclude ?? [])
          nixLockResult = yield* syncNixLocks({
            megarepoRoot,
            config,
            lockFile,
            excludeMembers,
            scope: all === true ? 'recursive' : 'direct',
            recursiveMegarepoMembers: new Set(nestedMegarepos),
          })
          if (nixLockResult.totalUpdates > 0) {
            yield* Effect.logInfo(
              `Synced ${nixLockResult.totalUpdates} Nix lock input(s) across ${nixLockResult.memberResults.length} member(s)`,
            )
          }
        }
      }
    }

    // Regenerate the local Nix workspace after syncing members (apply mode only).
    if (dryRun === false && changesWorkspace === true) {
      const outermostRootOpt = yield* findMegarepoRoot(megarepoRoot)
      const outermostRoot = Option.getOrElse(outermostRootOpt, () => megarepoRoot)
      yield* generateAll({
        megarepoRoot: megarepoRoot,
        outermostRoot,
        config,
      })
    }

    // Handle --all flag: recursively sync nested megarepos in parallel
    const nestedResults =
      all === true && nestedMegarepos.length > 0
        ? yield* Effect.all(
            nestedMegarepos.map((nestedName) => {
              const nestedPath = getMemberPath({ megarepoRoot, name: nestedName })
              const nestedRoot = EffectPath.unsafe.absoluteDir(
                nestedPath.endsWith('/') === true ? nestedPath : `${nestedPath}/`,
              )

              return Effect.gen(function* () {
                // In applyAfterFetch mode, run fetch first for nested megarepos
                // so they have a lock file before apply runs.
                if (options.applyAfterFetch === true) {
                  // Use a separate visited set for fetch — sharing the apply's visited
                  // set would cause the apply phase to skip megarepos already visited by fetch.
                  yield* syncMegarepo({
                    megarepoRoot: nestedRoot,
                    options: { ...options, mode: 'fetch', applyAfterFetch: false },
                    depth: depth + 1,
                    ...(onMissingRef !== undefined ? { onMissingRef } : {}),
                  })
                }
                return yield* syncMegarepo({
                  megarepoRoot: nestedRoot,
                  options,
                  depth: depth + 1,
                  visited,
                  ...(onMissingRef !== undefined ? { onMissingRef } : {}),
                })
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.succeed({
                    root: nestedRoot,
                    results: [
                      {
                        name: nestedName,
                        status: 'error' as const,
                        message: `Nested sync failed: ${'message' in error ? error.message : String(error)}`,
                      },
                    ],
                    nestedMegarepos: [],
                    nestedResults: [],
                    lockSyncResults: undefined,
                  } satisfies MegarepoSyncResult),
                ),
              )
            }),
            { concurrency: 4 },
          )
        : []

    return {
      root: megarepoRoot,
      results: allResults,
      nestedMegarepos,
      nestedResults,
      lockSyncResults: nixLockResult,
    } satisfies MegarepoSyncResult
  }).pipe(
    Effect.withSpan('megarepo/sync', {
      attributes: { 'span.label': megarepoRoot, root: megarepoRoot, mode: options.mode, depth },
    }),
  )

const toMegarepoSyncTree = (r: MegarepoSyncResult): MegarepoSyncTreeType => ({
  root: r.root,
  results: r.results,
  nestedMegarepos: r.nestedMegarepos,
  nestedResults: r.nestedResults.map(toMegarepoSyncTree),
})

/** Parse comma-separated member names */
const parseMemberList = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/**
 * Create an interactive prompt for missing refs.
 * Returns an Effect that prompts the user what to do when a branch doesn't exist.
 */
const createMissingRefPrompt = (
  info: MissingRefInfo,
): Effect.Effect<MissingRefAction, never, Terminal.Terminal> =>
  Effect.gen(function* () {
    const prompt = Prompt.select<MissingRefAction>({
      message: `Branch '${info.ref}' doesn't exist in ${info.memberName}`,
      choices: [
        {
          title: `Create from '${info.defaultBranch}'`,
          value: 'create' as const,
          description: `Create branch '${info.ref}' from '${info.defaultBranch}' and push to remote`,
        },
        {
          title: 'Skip this member',
          value: 'skip' as const,
          description: 'Continue syncing other members',
        },
        {
          title: 'Abort sync',
          value: 'abort' as const,
          description: 'Stop the sync operation',
        },
      ],
    })

    return yield* prompt.pipe(
      Effect.catchTag('QuitException', () => Effect.succeed('abort' as const)),
    )
  })

/** Execute a megarepo command with the given CLI options, rendering progress via TUI or structured output. */
export const runCommand = ({
  mode,
  output,
  dryRun,
  force,
  all,
  only,
  skip,
  gitProtocol,
  createBranches,
  verbose,
  applyAfterFetch = false,
  worktreeMode,
}: {
  mode: SyncMode
  output: OutputModeValue
  dryRun: boolean
  force: boolean
  all: boolean
  only: Option.Option<string>
  skip: Option.Option<string>
  gitProtocol: GitProtocol
  createBranches: boolean
  verbose: boolean
  /** When true, runs fetch first (silently), then apply with output rendering. Used by `mr fetch --apply`. */
  applyAfterFetch?: boolean
  /** Worktree strategy for apply mode: 'commit', 'tracking', or 'auto' (default). */
  worktreeMode?: 'commit' | 'tracking' | 'auto'
}) =>
  Effect.gen(function* () {
    const json = output === 'json' || output === 'ndjson'

    // Resolve worktree mode: 'auto' → commit in CI, tracking otherwise
    const resolvedWorktreeMode = worktreeMode ?? 'auto'
    const commitMode =
      resolvedWorktreeMode === 'commit' ||
      (resolvedWorktreeMode === 'auto' && process.env.CI === 'true')

    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isSome(only) === true && Option.isSome(skip) === true) {
      return yield* new InvalidOptionsError({
        message: '--only and --skip are mutually exclusive',
      })
    }

    const onlyMembers = Option.isSome(only) === true ? parseMemberList(only.value) : undefined
    const skipMembers = Option.isSome(skip) === true ? parseMemberList(skip.value) : undefined

    if (Option.isNone(root) === true) {
      return yield* new NotInMegarepoError({ message: 'No megarepo.json found' })
    }

    const workspaceName = yield* Git.deriveMegarepoName(root.value)
    const { config } = yield* readMegarepoConfig(root.value)
    const memberNames = Object.keys(config.members)

    const skippedMembers = memberNames.filter((memberName) => {
      if (onlyMembers !== undefined && onlyMembers.length > 0) {
        return !onlyMembers.includes(memberName)
      }
      if (skipMembers !== undefined && skipMembers.length > 0) {
        return skipMembers.includes(memberName)
      }
      return false
    })

    const displayMode = applyAfterFetch === true ? ('apply' as const) : mode
    const syncDisplayOptions = {
      mode: displayMode,
      dryRun,
      all,
      force: force || undefined,
      verbose: verbose || undefined,
      skippedMembers: skippedMembers.length > 0 ? skippedMembers : undefined,
    }

    const onMissingRef =
      createBranches === false && isTTY() === true
        ? (info: MissingRefInfo) => createMissingRefPrompt(info)
        : undefined

    // When applyAfterFetch is set, run fetch first (no output), then apply with rendering.
    // Capture fetch results to merge error information into the final output.
    let fetchResult: MegarepoSyncResult | undefined
    if (applyAfterFetch === true) {
      fetchResult = yield* syncMegarepo({
        megarepoRoot: root.value,
        options: {
          mode: 'fetch',
          dryRun,
          force,
          all,
          only: onlyMembers,
          skip: skipMembers,
          gitProtocol,
          createBranches,
        },
        ...(onMissingRef !== undefined ? { onMissingRef } : {}),
      })
    }

    const effectiveMode = applyAfterFetch === true ? 'apply' : mode

    const doSync = (progressHandle?: SyncUIHandle) =>
      syncMegarepo({
        megarepoRoot: root.value,
        options: {
          mode: effectiveMode,
          dryRun,
          force,
          all,
          only: onlyMembers,
          skip: skipMembers,
          gitProtocol,
          createBranches,
          ...(applyAfterFetch === true ? { applyAfterFetch: true } : {}),
          ...(commitMode === true ? { commitMode: true } : {}),
        },
        ...(progressHandle !== undefined ? { progressHandle } : {}),
        ...(onMissingRef !== undefined ? { onMissingRef } : {}),
      })

    /** Merge fetch errors into apply results so errors from the fetch phase are visible.
     * - Replace apply error results with fetch errors (fetch has the actual git error, apply only knows "not in lock file")
     * - Add fetch errors for members not present in apply results at all
     */
    const mergeFetchErrors = (applyResult: MegarepoSyncResult): MegarepoSyncResult => {
      if (fetchResult === undefined) return applyResult

      // Build a map of fetch errors by member name
      const fetchErrorMap = new Map<string, MemberSyncResult>()
      for (const r of fetchResult.results) {
        if (r.status === 'error') fetchErrorMap.set(r.name, r)
      }

      // Replace apply error results with fetch errors (better context), pass through non-errors
      const mergedResults = applyResult.results.map((r) => {
        if (r.status === 'error') {
          const fetchError = fetchErrorMap.get(r.name)
          if (fetchError !== undefined) {
            fetchErrorMap.delete(r.name)
            return fetchError
          }
        } else {
          fetchErrorMap.delete(r.name)
        }
        return r
      })

      // Add remaining fetch errors for members not in apply results at all
      const remainingFetchErrors = [...fetchErrorMap.values()]

      // Merge nested results too
      const applyNestedRoots = new Set(applyResult.nestedResults.map((r) => r.root))
      const fetchNestedErrors = fetchResult.nestedResults.filter(
        (nr) => !applyNestedRoots.has(nr.root),
      )

      return {
        ...applyResult,
        results: [...mergedResults, ...remainingFetchErrors],
        nestedResults: [...applyResult.nestedResults, ...fetchNestedErrors],
      }
    }

    const renderSyncResult = ({
      syncResult: rawSyncResult,
      dispatch,
    }: {
      syncResult: MegarepoSyncResult
      dispatch: (action: SyncAction) => void
    }) => {
      const syncResult = mergeFetchErrors(rawSyncResult)
      const generatedFiles = getEnabledGenerators(config)
      const lockSyncResults: ReadonlyArray<MemberLockSyncResult> =
        syncResult.lockSyncResults?.memberResults.map((mr) => ({
          memberName: mr.memberName,
          files: mr.files.map((f) => ({
            type: f.type,
            updatedInputs: f.updatedInputs.map((u) => {
              switch (u._tag) {
                case 'RevUpdate':
                  return {
                    _tag: 'RevUpdate' as const,
                    inputName: u.inputName,
                    memberName: u.memberName,
                    oldRev: u.oldRev.slice(0, 7),
                    newRev: u.newRev.slice(0, 7),
                  }
                case 'RefUpdate':
                  return {
                    _tag: 'RefUpdate' as const,
                    inputName: u.inputName,
                    memberName: u.memberName,
                    oldRef: u.oldRef,
                    newRef: u.newRef,
                  }
                case 'SchemeUpdate':
                  return {
                    _tag: 'SchemeUpdate' as const,
                    inputName: u.inputName,
                  }
              }
            }),
          })),
        })) ?? []

      const sharedSourceUpdatesFromLockSources: ReadonlyArray<LockSharedSourceUpdate> =
        syncResult.lockSyncResults?.sharedLockSourceResults
          .filter((r) => r.updatedMembers.length > 0)
          .map((r) => ({
            _tag: 'SharedSourceUpdate' as const,
            sourceName: r.label,
            sourceMemberName: r.sourceMember,
            targetCount: r.updatedMembers.length,
          })) ?? []

      const sharedSourceUpdatesFromInputSource: ReadonlyArray<LockSharedSourceUpdate> = syncResult
        .lockSyncResults?.sharedInputSourceResult?.updatedMembers.length
        ? [
            {
              _tag: 'SharedSourceUpdate' as const,
              sourceName: 'shared-inputs',
              sourceMemberName: syncResult.lockSyncResults.sharedInputSourceResult.sourceMember,
              targetCount: syncResult.lockSyncResults.sharedInputSourceResult.updatedMembers.length,
            },
          ]
        : []

      const sharedSourceUpdates: ReadonlyArray<LockSharedSourceUpdate> = [
        ...sharedSourceUpdatesFromLockSources,
        ...sharedSourceUpdatesFromInputSource,
      ]

      const syncErrors = collectSyncErrors(syncResult)
      const syncErrorItems = syncErrors.map((e) => ({
        megarepoRoot: e.megarepoRoot,
        memberName: e.member.name,
        message: e.member.message ?? null,
      }))

      dispatch({
        _tag: 'SetState',
        state: {
          _tag: syncErrorItems.length > 0 ? 'Error' : 'Success',
          workspace: { name: workspaceName, root: root.value },
          options: syncDisplayOptions,
          members: memberNames,
          activeMembers: [],
          results: syncResult.results,
          logs: [],
          startedAt: null,
          nestedMegarepos: [...syncResult.nestedMegarepos],
          generatedFiles,
          lockSyncResults,
          sharedSourceUpdates,
          syncTree: toMegarepoSyncTree(syncResult),
          syncErrors: syncErrorItems,
          syncErrorCount: syncErrorItems.length,
          preflightIssues: [],
        },
      })
    }

    if (json === false && isTTY() === true) {
      const ui = yield* startSyncUI({
        workspaceName,
        workspaceRoot: root.value,
        memberNames,
        mode: displayMode,
        dryRun,
        all,
        force,
        verbose,
        skippedMembers,
      })

      const syncResult = yield* doSync(ui)
      renderSyncResult({ syncResult, dispatch: (state) => ui.dispatch(state) })
      yield* finishSyncUI(ui)
      return syncResult
    }

    const syncResult = yield* doSync()
    yield* run(
      SyncApp,
      (tui) =>
        Effect.sync(() => {
          renderSyncResult({ syncResult, dispatch: (state) => tui.dispatch(state) })
        }),
      { view: React.createElement(SyncView, { stateAtom: SyncApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))

    return syncResult
  }).pipe(Effect.scoped, Effect.provide(StoreLayer))
