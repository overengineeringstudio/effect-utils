/**
 * Sync Command
 *
 * Sync members: clone to store and create symlinks.
 */

import * as Cli from '@effect/cli'
import { Prompt } from '@effect/cli'
import type { CommandExecutor, Terminal } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import {
  CONFIG_FILE_NAME,
  getMemberPath,
  getMembersRoot,
  getSourceUrl,
  isRemoteSource,
  MegarepoConfig,
  parseSourceString,
} from '../../lib/config.ts'
import { generateAll, getEnabledGenerators } from '../../lib/generators/mod.ts'
import * as Git from '../../lib/git.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  LOCK_FILE_NAME,
  LockFile,
  readLockFile,
  syncLockWithConfig,
  upsertLockedMember,
} from '../../lib/lock.ts'
import { syncNixLocks, type NixLockSyncResult } from '../../lib/nix-lock/mod.ts'
import { type Store, StoreLayer } from '../../lib/store.ts'
import {
  type GitProtocol,
  makeRepoSemaphoreMap,
  type MissingRefAction,
  type MissingRefInfo,
  collectSyncErrors,
  syncMember,
  type MegarepoSyncResult,
  type MemberSyncResult,
} from '../../lib/sync/mod.ts'
import type { MegarepoSyncTree as MegarepoSyncTreeType } from '../../lib/sync/schema.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer, verboseOption } from '../context.ts'
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
    dryRun: boolean
    pull: boolean
    frozen: boolean
    force: boolean
    all: boolean
    only: ReadonlyArray<string> | undefined
    skip: ReadonlyArray<string> | undefined
    gitProtocol: GitProtocol
    createBranches: boolean
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
  | PlatformError.PlatformError
  | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Store | R
> =>
  Effect.gen(function* () {
    const { dryRun, pull, frozen, force, all, only, skip, gitProtocol, createBranches } = options
    const fs = yield* FileSystem.FileSystem

    // Resolve to physical path for deduplication (handles symlinks)
    const resolvedRoot = yield* fs.realPath(megarepoRoot)

    // Check if we've already synced this megarepo (circuit breaker for diamond dependencies)
    if (visited.has(resolvedRoot)) {
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
    const configPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (!dryRun) {
      const membersRoot = getMembersRoot(megarepoRoot)
      yield* fs.makeDirectory(membersRoot, { recursive: true })
    }

    // Load lock file (optional unless --frozen)
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
      if (source !== undefined && isRemoteSource(source)) {
        remoteMemberNames.add(name)
      }
    }

    // Compute which members will be skipped based on --only and --skip options
    // This is needed before the frozen check to correctly filter staleness detection
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

    // Check --frozen requirements
    if (frozen) {
      if (lockFile === undefined) {
        return yield* new LockFileRequiredError({ message: 'Lock file required for --frozen' })
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
      if (staleness.isStale) {
        return yield* new StaleLockFileError({
          message: 'Lock file is stale',
          addedMembers: staleness.addedMembers,
          removedMembers: staleness.removedMembers,
        })
      }
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
            dryRun,
            pull,
            frozen,
            force,
            semaphoreMap,
            gitProtocol,
            createBranches,
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

    // Detect and remove orphaned symlinks (members removed from config)
    const membersRoot = getMembersRoot(megarepoRoot)
    const configuredMemberNames = new Set(Object.keys(config.members))
    const removedResults: Array<MemberSyncResult> = []

    // Only check for orphans if repos/ directory exists
    const membersRootExists = yield* fs
      .exists(membersRoot)
      .pipe(Effect.catchAll(() => Effect.succeed(false)))

    if (membersRootExists) {
      const existingEntries = yield* fs
        .readDirectory(membersRoot)
        .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

      for (const entry of existingEntries) {
        // Skip if this member is still in config
        if (configuredMemberNames.has(entry)) continue

        // Skip if this member was explicitly skipped via --only/--skip
        if (skippedMemberNames.has(entry)) continue

        const entryPath = EffectPath.ops.join(membersRoot, EffectPath.unsafe.relativeFile(entry))

        // Only remove symlinks (not directories that might be local repos)
        const linkTarget = yield* fs
          .readLink(entryPath)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (linkTarget !== null) {
          // This is a symlink - it's an orphan, remove it
          if (!dryRun) {
            yield* fs.remove(entryPath).pipe(Effect.catchAll(() => Effect.void))
          }
          removedResults.push({
            name: entry,
            status: 'removed',
            message: linkTarget, // Store symlink target for display
          })
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
          const nestedConfigPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const hasNestedConfig = yield* fs
            .exists(nestedConfigPath)
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
          return hasNestedConfig ? result.name : null
        }),
      ),
      { concurrency: 'unbounded' },
    )
    const nestedMegarepos = nestedMegarepoChecks.filter((name): name is string => name !== null)

    // Track Nix lock sync results (populated if lock sync runs)
    let nixLockResult: NixLockSyncResult | undefined = undefined

    // Update lock file (unless dry run or frozen)
    if (!dryRun && !frozen) {
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
        const commit = 'commit' in result ? result.commit : undefined
        const ref = 'ref' in result ? result.ref : undefined
        if (commit === undefined || ref === undefined) continue

        const sourceString = config.members[result.name]
        if (sourceString === undefined) continue
        const source = parseSourceString(sourceString)
        if (source === undefined || !isRemoteSource(source)) continue

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

      // Write lock file only if content changed (avoids unnecessary dirty-tree hash changes
      // that trigger direnv re-evaluation → devenv:enterShell → megarepo:sync feedback loop)
      const newContent = yield* Schema.encode(Schema.parseJson(LockFile, { space: 2 }))(lockFile)
      const existingContent = yield* fs.readFileString(lockPath).pipe(
        Effect.catchAll(() => Effect.succeed('')),
      )
      if (newContent + '\n' !== existingContent) {
        yield* fs.writeFileString(lockPath, newContent + '\n')
      }

      // Sync Nix lock files (flake.lock, devenv.lock) in member repos
      // - lockSync.enabled: true → always enable (explicit override)
      // - lockSync.enabled: false → always disable (explicit override)
      // - lockSync.enabled: undefined → auto-detect based on root lock file presence
      const fs = yield* FileSystem.FileSystem
      const lockSyncExplicitSetting = config.lockSync?.enabled
      const devenvLockExists = yield* fs.exists(
        EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeFile('devenv.lock')),
      )
      const flakeLockExists = yield* fs.exists(
        EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeFile('flake.lock')),
      )
      const lockSyncEnabled =
        lockSyncExplicitSetting === true ||
        (lockSyncExplicitSetting !== false && (devenvLockExists || flakeLockExists))

      if (lockSyncEnabled) {
        const excludeMembers = new Set(config.lockSync?.exclude ?? [])
        nixLockResult = yield* syncNixLocks({
          megarepoRoot,
          config,
          lockFile,
          excludeMembers,
        })
        if (nixLockResult.totalUpdates > 0) {
          yield* Effect.logInfo(
            `Synced ${nixLockResult.totalUpdates} Nix lock input(s) across ${nixLockResult.memberResults.length} member(s)`,
          )
        }
      }
    }

    // Always regenerate the local Nix workspace after syncing members.
    if (!dryRun) {
      const outermostRootOpt = yield* findMegarepoRoot(megarepoRoot)
      const outermostRoot = Option.getOrElse(outermostRootOpt, () => megarepoRoot)
      yield* generateAll({
        megarepoRoot: megarepoRoot,
        outermostRoot,
        config,
      })
    }

    // Handle --all flag: recursively sync nested megarepos
    const nestedResults: MegarepoSyncResult[] = []
    if (all && nestedMegarepos.length > 0) {
      for (const nestedName of nestedMegarepos) {
        const nestedPath = getMemberPath({ megarepoRoot, name: nestedName })
        // Convert to AbsoluteDirPath (add trailing slash if needed)
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          nestedPath.endsWith('/') ? nestedPath : `${nestedPath}/`,
        )

        const nestedResult = yield* syncMegarepo({
          megarepoRoot: nestedRoot,
          options,
          depth: depth + 1,
          visited, // Pass visited set to prevent duplicate syncing
          ...(onMissingRef !== undefined ? { onMissingRef } : {}),
        }).pipe(
          Effect.catchAll(() =>
            // Return an empty result on error (errors are already in results)
            Effect.succeed({
              root: nestedRoot,
              results: [],
              nestedMegarepos: [],
              nestedResults: [],
              lockSyncResults: undefined,
            } satisfies MegarepoSyncResult),
          ),
        )

        nestedResults.push(nestedResult)
      }
    }

    return {
      root: megarepoRoot,
      results: allResults,
      nestedMegarepos,
      nestedResults,
      lockSyncResults: nixLockResult,
    } satisfies MegarepoSyncResult
  })

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

/** Sync members: clone to store and create symlinks */
export const syncCommand = Cli.Command.make(
  'sync',
  {
    output: outputOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    pull: Cli.Options.boolean('pull').pipe(
      Cli.Options.withDescription('Fetch and update unpinned members to latest remote commits'),
      Cli.Options.withDefault(false),
    ),
    frozen: Cli.Options.boolean('frozen').pipe(
      Cli.Options.withDescription(
        'Use exact commits from lock file, clone if needed, never update lock (CI mode)',
      ),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Force sync even with dirty worktrees or pinned members'),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively sync nested megarepos'),
      Cli.Options.withDefault(false),
    ),
    only: Cli.Options.text('only').pipe(
      Cli.Options.withDescription('Only sync specified members (comma-separated)'),
      Cli.Options.optional,
    ),
    skip: Cli.Options.text('skip').pipe(
      Cli.Options.withDescription('Skip specified members (comma-separated)'),
      Cli.Options.optional,
    ),
    gitProtocol: Cli.Options.choice('git-protocol', ['ssh', 'https', 'auto']).pipe(
      Cli.Options.withDescription(
        'Git protocol for cloning: ssh (default for new clones), https, or auto (use lock file URL if available)',
      ),
      Cli.Options.withDefault('auto' as const),
    ),
    createBranches: Cli.Options.boolean('create-branches').pipe(
      Cli.Options.withDescription('Create branches that do not exist (from default branch)'),
      Cli.Options.withDefault(false),
    ),
    verbose: verboseOption,
  },
  ({
    output,
    dryRun,
    pull,
    frozen,
    force,
    all,
    only,
    skip,
    gitProtocol,
    createBranches,
    verbose,
  }) =>
    Effect.gen(function* () {
      const json = output === 'json' || output === 'ndjson'

      const cwd = yield* Cwd
      const fs = yield* FileSystem.FileSystem
      const root = yield* findMegarepoRoot(cwd)

      // Validate mutual exclusivity of --only and --skip
      if (Option.isSome(only) && Option.isSome(skip)) {
        return yield* new InvalidOptionsError({
          message: '--only and --skip are mutually exclusive',
        })
      }

      // Parse member filter options
      const onlyMembers = Option.isSome(only) ? parseMemberList(only.value) : undefined
      const skipMembers = Option.isSome(skip) ? parseMemberList(skip.value) : undefined

      if (Option.isNone(root)) {
        return yield* new NotInMegarepoError({ message: 'No megarepo.json found' })
      }

      // Get workspace name
      const name = yield* Git.deriveMegarepoName(root.value)

      // Load config
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)
      const memberNames = Object.keys(config.members)

      // Compute skipped members for display
      const skippedMembers = memberNames.filter((name) => {
        if (onlyMembers !== undefined && onlyMembers.length > 0) return !onlyMembers.includes(name)
        if (skipMembers !== undefined && skipMembers.length > 0) return skipMembers.includes(name)
        return false
      })

      // Build options object for state
      const syncDisplayOptions = {
        dryRun,
        frozen,
        pull,
        all,
        force: force || undefined,
        verbose: verbose || undefined,
        skippedMembers: skippedMembers.length > 0 ? skippedMembers : undefined,
      }

      // Determine if we should use live progress (TTY and not JSON mode)
      const useLiveProgress = !json && isTTY()

      if (useLiveProgress) {
        // Start live progress UI (React-based)
        const ui = yield* startSyncUI({
          workspaceName: name,
          workspaceRoot: root.value,
          memberNames,
          dryRun,
          frozen,
          pull,
          all,
          force,
          verbose,
          skippedMembers,
        })

        // Create interactive prompt callback if in TTY mode and not using --create-branches
        const onMissingRef =
          !createBranches && isTTY()
            ? (info: MissingRefInfo) => createMissingRefPrompt(info)
            : undefined

        // Run the sync with progress updates
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: {
            dryRun,
            pull,
            frozen,
            force,
            all,
            only: onlyMembers,
            skip: skipMembers,
            gitProtocol,
            createBranches,
          },
          progressHandle: ui,
          ...(onMissingRef !== undefined ? { onMissingRef } : {}),
        })

        // Mark complete and finish UI
        const generatedFiles = getEnabledGenerators(config)

        // Transform lock sync results to TUI format
        const lockSyncResults =
          syncResult.lockSyncResults?.memberResults.map((mr) => ({
            memberName: mr.memberName,
            files: mr.files.map((f) => ({
              type: f.type,
              updatedInputs: f.updatedInputs.map((u) => ({
                inputName: u.inputName,
                memberName: u.memberName,
                oldRev: u.oldRev.slice(0, 7),
                newRev: u.newRev.slice(0, 7),
              })),
            })),
          })) ?? []

        const syncErrors = collectSyncErrors(syncResult)
        const syncErrorItems = syncErrors.map((e) => ({
          megarepoRoot: e.megarepoRoot,
          memberName: e.member.name,
          message: e.member.message ?? null,
        }))

        ui.dispatch({
          _tag: 'SetState',
          state: {
            _tag: syncErrorItems.length > 0 ? 'Error' : 'Success',
            workspace: { name, root: root.value },
            options: syncDisplayOptions,
            members: memberNames,
            activeMember: null,
            results: syncResult.results,
            logs: [],
            startedAt: null,
            nestedMegarepos: [...syncResult.nestedMegarepos],
            generatedFiles,
            lockSyncResults: lockSyncResults,
            syncTree: toMegarepoSyncTree(syncResult),
            syncErrors: syncErrorItems,
            syncErrorCount: syncErrorItems.length,
          },
        })

        yield* finishSyncUI(ui)

        return syncResult
      } else {
        // Non-TTY / JSON / NDJSON / CI: use SyncApp with outputModeLayer
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: {
            dryRun,
            pull,
            frozen,
            force,
            all,
            only: onlyMembers,
            skip: skipMembers,
            gitProtocol,
            createBranches,
          },
        })

        const generatedFiles = getEnabledGenerators(config)

        // Transform lock sync results to TUI format
        const lockSyncResults =
          syncResult.lockSyncResults?.memberResults.map((mr) => ({
            memberName: mr.memberName,
            files: mr.files.map((f) => ({
              type: f.type,
              updatedInputs: f.updatedInputs.map((u) => ({
                inputName: u.inputName,
                memberName: u.memberName,
                oldRev: u.oldRev.slice(0, 7),
                newRev: u.newRev.slice(0, 7),
              })),
            })),
          })) ?? []

        // Render final state via SyncApp
        yield* run(
          SyncApp,
          (tui) =>
            Effect.sync(() => {
              const syncErrors = collectSyncErrors(syncResult)
              const syncErrorItems = syncErrors.map((e) => ({
                megarepoRoot: e.megarepoRoot,
                memberName: e.member.name,
                message: e.member.message ?? null,
              }))

              tui.dispatch({
                _tag: 'SetState',
                state: {
                  _tag: syncErrorItems.length > 0 ? 'Error' : 'Success',
                  workspace: { name, root: root.value },
                  options: syncDisplayOptions,
                  members: memberNames,
                  activeMember: null,
                  results: syncResult.results,
                  logs: [],
                  startedAt: null,
                  nestedMegarepos: [...syncResult.nestedMegarepos],
                  generatedFiles,
                  lockSyncResults,
                  syncTree: toMegarepoSyncTree(syncResult),
                  syncErrors: syncErrorItems,
                  syncErrorCount: syncErrorItems.length,
                },
              })
            }),
          { view: React.createElement(SyncView, { stateAtom: SyncApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))

        return syncResult
      }
    }).pipe(Effect.scoped, Effect.provide(StoreLayer), Effect.withSpan('megarepo/sync')),
).pipe(
  Cli.Command.withDescription(
    'Ensure members exist and update lock file to current worktree commits. Use --pull to fetch from remote.',
  ),
)
