/**
 * Sync Command
 *
 * Sync members: clone to store and create symlinks.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Console, Effect, Layer, Option, type ParseResult, Schema } from 'effect'

import { isTTY, styled, symbols } from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME,
  getMemberPath,
  getMembersRoot,
  getSourceUrl,
  isRemoteSource,
  MegarepoConfig,
  parseSourceString,
} from '../../lib/config.ts'
import {
  generateAll,
  getEnabledGenerators,
  type NixGeneratorError,
} from '../../lib/generators/mod.ts'
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
import { type Store, StoreLayer } from '../../lib/store.ts'
import { flattenSyncResults, syncMember, type MegarepoSyncResult } from '../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'
import {
  SyncProgressEmpty,
  setMemberSyncing,
  applySyncResult,
  completeSyncProgress,
  startSyncProgressUI,
  finishSyncProgressUI,
  type SyncProgressService,
} from '../progress/mod.ts'
import { outputLines, renderSync } from '../renderers/mod.ts'

// =============================================================================
// Sync Errors
// =============================================================================

/** Error when not in a megarepo */
export class NotInMegarepoError extends Schema.TaggedError<NotInMegarepoError>()(
  'NotInMegarepoError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is required but missing */
export class LockFileRequiredError extends Schema.TaggedError<LockFileRequiredError>()(
  'LockFileRequiredError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is stale */
export class StaleLockFileError extends Schema.TaggedError<StaleLockFileError>()(
  'StaleLockFileError',
  {
    message: Schema.String,
    addedMembers: Schema.Array(Schema.String),
    removedMembers: Schema.Array(Schema.String),
  },
) {}

/**
 * Sync a megarepo at the given root path.
 * This is extracted to enable recursive syncing for --deep mode.
 *
 * @param visited - Set of already-synced megarepo roots (resolved paths) to prevent duplicate syncing
 *                  in diamond dependency scenarios (e.g., A→B, A→C, B→D, C→D where D would be synced twice)
 * @param withProgress - When true, uses limited concurrency (4) for visible progress updates
 */
export const syncMegarepo = ({
  megarepoRoot,
  options,
  depth = 0,
  visited = new Set<string>(),
  withProgress = false,
}: {
  megarepoRoot: AbsoluteDirPath
  options: {
    json: boolean
    dryRun: boolean
    pull: boolean
    frozen: boolean
    force: boolean
    deep: boolean
    only: ReadonlyArray<string> | undefined
    skip: ReadonlyArray<string> | undefined
  }
  depth?: number
  visited?: Set<string>
  withProgress?: boolean
}): Effect.Effect<
  MegarepoSyncResult,
  | NotInMegarepoError
  | LockFileRequiredError
  | StaleLockFileError
  | NixGeneratorError
  | PlatformError.PlatformError
  | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Store | SyncProgressService
> =>
  Effect.gen(function* () {
    const { json, dryRun, pull, frozen, force, deep, only, skip } = options
    const fs = yield* FileSystem.FileSystem
    const indent = '  '.repeat(depth)

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
        if (json) {
          console.log(
            JSON.stringify({
              error: 'no_lock',
              message: 'Lock file required for --frozen',
              root: megarepoRoot,
            }),
          )
        } else {
          yield* Console.error(
            `${indent}${styled.red(symbols.cross)} Lock file required for --frozen mode`,
          )
        }
        return yield* new LockFileRequiredError({
          message: 'Lock file required for --frozen',
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
      if (staleness.isStale) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'stale_lock',
              message: 'Lock file is stale',
              root: megarepoRoot,
              added: staleness.addedMembers,
              removed: staleness.removedMembers,
            }),
          )
        } else {
          yield* Console.error(`${indent}${styled.red(symbols.cross)} Lock file is stale`)
          if (staleness.addedMembers.length > 0) {
            yield* Console.log(styled.dim(`${indent}  Added: ${staleness.addedMembers.join(', ')}`))
          }
          if (staleness.removedMembers.length > 0) {
            yield* Console.log(
              styled.dim(`${indent}  Removed: ${staleness.removedMembers.join(', ')}`),
            )
          }
        }
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

    // Sync all members with limited concurrency for visible progress
    // Use unbounded for non-TTY (faster) or limited (4) for TTY (visible progress)
    const concurrency = withProgress ? 4 : 'unbounded'

    const results = yield* Effect.all(
      members.map(([name, sourceString]) =>
        Effect.gen(function* () {
          // Mark as syncing in progress service
          if (withProgress) {
            yield* setMemberSyncing({ memberName: name }).pipe(Effect.catchAll(() => Effect.void))
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
          })

          // Apply result to progress service
          if (withProgress) {
            yield* applySyncResult(result).pipe(Effect.catchAll(() => Effect.void))
          }

          return result
        }),
      ),
      { concurrency },
    )

    // Check which members are themselves megarepos (for --deep)
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

      // Write lock file
      yield* writeLockFile({ lockPath, lockFile })

      // Sync Nix lock files (flake.lock, devenv.lock) in member repos
      // This is opt-out: enabled by default when nix generator is enabled
      const nixLockSyncEnabled =
        config.generators?.nix?.enabled === true &&
        config.generators.nix.lockSync?.enabled !== false
      if (nixLockSyncEnabled) {
        const excludeMembers = new Set(config.generators?.nix?.lockSync?.exclude ?? [])
        const nixLockResult = yield* syncNixLocks({
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

    // Handle --deep flag: recursively sync nested megarepos
    const nestedResults: MegarepoSyncResult[] = []
    if (deep && nestedMegarepos.length > 0) {
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
        }).pipe(
          Effect.catchAll(() =>
            // Return an empty result on error (errors are already in results)
            Effect.succeed({
              root: nestedRoot,
              results: [],
              nestedMegarepos: [],
              nestedResults: [],
            } satisfies MegarepoSyncResult),
          ),
        )

        nestedResults.push(nestedResult)
      }
    }

    return {
      root: megarepoRoot,
      results,
      nestedMegarepos,
      nestedResults,
    } satisfies MegarepoSyncResult
  })

/** Parse comma-separated member names */
const parseMemberList = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/** Sync members: clone to store and create symlinks */
export const syncCommand = Cli.Command.make(
  'sync',
  {
    json: jsonOption,
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
    deep: Cli.Options.boolean('deep').pipe(
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
  },
  ({ json, dryRun, pull, frozen, force, deep, only, skip }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const fs = yield* FileSystem.FileSystem
      const root = yield* findMegarepoRoot(cwd)

      // Validate mutual exclusivity of --only and --skip
      if (Option.isSome(only) && Option.isSome(skip)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'invalid_options',
              message: '--only and --skip are mutually exclusive',
            }),
          )
        } else {
          yield* Console.error(
            `${styled.red(symbols.cross)} --only and --skip are mutually exclusive`,
          )
        }
        return yield* Effect.fail(new Error('--only and --skip are mutually exclusive'))
      }

      // Parse member filter options
      const onlyMembers = Option.isSome(only) ? parseMemberList(only.value) : undefined
      const skipMembers = Option.isSome(skip) ? parseMemberList(skip.value) : undefined

      if (Option.isNone(root)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: 'No megarepo.json found',
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* new NotInMegarepoError({
          message: 'No megarepo.json found',
        })
      }

      // Get workspace name
      const name = yield* Git.deriveMegarepoName(root.value)

      // Determine if we should use live progress (TTY and not JSON mode)
      const useLiveProgress = !json && isTTY()

      if (useLiveProgress) {
        // Load config to get member names for progress display
        const configPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* fs.readFileString(configPath)
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)
        const memberNames = Object.keys(config.members)

        // Start live progress UI
        const ui = yield* startSyncProgressUI({
          workspaceName: name,
          workspaceRoot: root.value,
          memberNames,
          dryRun,
          frozen,
          pull,
          deep,
        })

        // Run the sync with progress updates
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep, only: onlyMembers, skip: skipMembers },
          withProgress: true,
        })

        // Mark complete and finish UI
        yield* completeSyncProgress()
        yield* finishSyncProgressUI(ui)

        // Print generator output after progress UI completes
        const generatedFiles = getEnabledGenerators(config)
        if (generatedFiles.length > 0) {
          yield* Console.log('')
          yield* Console.log(dryRun ? 'Would generate:' : 'Generated:')
          for (const file of generatedFiles) {
            const symbol = dryRun ? styled.dim('→') : styled.green(symbols.check)
            yield* Console.log(`  ${symbol} ${styled.bold(file)}`)
          }
        }

        // Return result (already displayed via UI)
        return syncResult
      } else {
        // Non-TTY or JSON mode: use original batch rendering
        // Load config to get enabled generators
        const configPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* fs.readFileString(configPath)
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep, only: onlyMembers, skip: skipMembers },
        })

        // Get list of files that would be / were generated
        const generatedFiles = getEnabledGenerators(config)

        // Output results
        if (json) {
          console.log(JSON.stringify(flattenSyncResults(syncResult)))
        } else {
          // Render using the batch renderer (for non-TTY)
          const lines = renderSync({
            name,
            root: root.value,
            results: syncResult.results,
            nestedMegarepos: syncResult.nestedMegarepos,
            deep,
            dryRun,
            frozen,
            pull,
            generatedFiles,
          })
          yield* outputLines(lines)
        }

        return syncResult
      }
    }).pipe(
      Effect.provide(Layer.merge(StoreLayer, SyncProgressEmpty)),
      Effect.withSpan('megarepo/sync'),
    ),
).pipe(
  Cli.Command.withDescription(
    'Ensure members exist and update lock file to current worktree commits. Use --pull to fetch from remote.',
  ),
)
