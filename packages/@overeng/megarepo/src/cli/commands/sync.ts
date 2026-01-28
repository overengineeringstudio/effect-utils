/**
 * Sync Command
 *
 * Sync members: clone to store and create symlinks.
 */

import React from 'react'
import * as Cli from '@effect/cli'
import { Prompt } from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, Terminal, type Error as PlatformError } from '@effect/platform'
import { Console, Effect, Layer, Option, type ParseResult, Schema } from 'effect'

import { isTTY } from '@overeng/cli-ui'
import { Box, Text } from '@overeng/tui-react'
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
import { syncNixLocks } from '../../lib/nix-lock/mod.ts'
import { type Store, StoreLayer } from '../../lib/store.ts'
import {
  countSyncResults,
  flattenSyncResults,
  type GitProtocol,
  makeRepoSemaphoreMap,
  type MissingRefAction,
  type MissingRefInfo,
  syncMember,
  type MegarepoSyncResult,
  type MemberSyncResult,
} from '../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, jsonOption, verboseOption } from '../context.ts'
import {
  SyncProgressReactLayer,
  setMemberSyncing,
  applySyncResult,
  completeSyncProgress,
  startSyncProgressUIReact,
  finishSyncProgressUIReact,
  type SyncProgressService,
} from '../progress/mod.ts'
import { renderToString } from '@overeng/tui-react'

import { SyncOutput } from '../renderers/SyncOutput.tsx'

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

/** Error when member sync operations fail */
export class SyncFailedError extends Schema.TaggedError<SyncFailedError>()('SyncFailedError', {
  message: Schema.String,
  errorCount: Schema.Number,
  failedMembers: Schema.Array(Schema.String),
}) {}

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
  onMissingRef,
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
    verbose: boolean
    gitProtocol: GitProtocol
    createBranches: boolean
  }
  depth?: number
  visited?: Set<string>
  withProgress?: boolean
  /** Callback for interactive prompts when a ref doesn't exist */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMissingRef?: (info: MissingRefInfo) => Effect.Effect<MissingRefAction, any, any>
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
    const { json, dryRun, pull, frozen, force, deep, only, skip, verbose, gitProtocol, createBranches } = options
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

    // Verbose: show sync configuration
    if (verbose && !json && depth === 0) {
      const verboseOutput = yield* Effect.promise(() =>
        renderToString(
          React.createElement(Box, null,
            React.createElement(Text, { dim: true }, `Sync mode: ${frozen ? 'frozen' : pull ? 'pull' : 'default'}`),
            dryRun ? React.createElement(Text, { dim: true }, 'Dry run: true') : null,
            force ? React.createElement(Text, { dim: true }, 'Force: true') : null,
            deep ? React.createElement(Text, { dim: true }, 'Deep: true') : null,
          ),
        ),
      )
      yield* Console.log(verboseOutput)
    }

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
          const output = yield* Effect.promise(() =>
            renderToString(
              React.createElement(Box, { flexDirection: 'row' },
                React.createElement(Text, null, indent),
                React.createElement(Text, { color: 'red' }, '\u2717'),
                React.createElement(Text, null, ' Lock file required for --frozen mode'),
              ),
            ),
          )
          yield* Console.error(output)
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
          const staleOutput = yield* Effect.promise(() =>
            renderToString(
              React.createElement(Box, null,
                React.createElement(Box, { flexDirection: 'row' },
                  React.createElement(Text, null, indent),
                  React.createElement(Text, { color: 'red' }, '\u2717'),
                  React.createElement(Text, null, ' Lock file is stale'),
                ),
                staleness.addedMembers.length > 0
                  ? React.createElement(Text, { dim: true }, `${indent}  Added: ${staleness.addedMembers.join(', ')}`)
                  : null,
                staleness.removedMembers.length > 0
                  ? React.createElement(Text, { dim: true }, `${indent}  Removed: ${staleness.removedMembers.join(', ')}`)
                  : null,
              ),
            ),
          )
          yield* Console.log(staleOutput)
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

    // Verbose: show filtered members
    if (verbose && !json && skippedMemberNames.size > 0) {
      const skipOutput = yield* Effect.promise(() =>
        renderToString(
          React.createElement(Text, { dim: true }, `Skipping ${skippedMemberNames.size} member(s): ${[...skippedMemberNames].join(', ')}`),
        ),
      )
      yield* Console.log(skipOutput)
    }

    // Create a semaphore map for serializing bare repo creation per repo URL.
    // This prevents race conditions when multiple members reference the same repo
    // (e.g., jq-latest and jq-v16 both from jqlang/jq).
    const semaphoreMap = yield* makeRepoSemaphoreMap()

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
            semaphoreMap,
            gitProtocol,
            createBranches,
            ...(onMissingRef !== undefined ? { onMissingRef } : {}),
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

        const entryPath = EffectPath.ops.join(
          membersRoot,
          EffectPath.unsafe.relativeFile(entry),
        )

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
          ...(onMissingRef !== undefined ? { onMissingRef } : {}),
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
      results: allResults,
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

/**
 * Create an interactive prompt for missing refs.
 * Returns an Effect that prompts the user what to do when a branch doesn't exist.
 */
const createMissingRefPrompt = (info: MissingRefInfo): Effect.Effect<MissingRefAction, never, Terminal.Terminal> =>
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
  ({ json, dryRun, pull, frozen, force, deep, only, skip, gitProtocol, createBranches, verbose }) =>
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
          const output = yield* Effect.promise(() =>
            renderToString(
              React.createElement(Box, { flexDirection: 'row' },
                React.createElement(Text, { color: 'red' }, '\u2717'),
                React.createElement(Text, null, ' --only and --skip are mutually exclusive'),
              ),
            ),
          )
          yield* Console.error(output)
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
          const output = yield* Effect.promise(() =>
            renderToString(
              React.createElement(Box, { flexDirection: 'row' },
                React.createElement(Text, { color: 'red' }, '\u2717'),
                React.createElement(Text, null, ' Not in a megarepo'),
              ),
            ),
          )
          yield* Console.error(output)
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

        // Start live progress UI (React-based)
        const ui = yield* startSyncProgressUIReact({
          workspaceName: name,
          workspaceRoot: root.value,
          memberNames,
          dryRun,
          frozen,
          pull,
          deep,
        })

        // Create interactive prompt callback if in TTY mode and not using --create-branches
        const onMissingRef = !createBranches && isTTY()
          ? (info: MissingRefInfo) => createMissingRefPrompt(info)
          : undefined

        // Run the sync with progress updates
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep, only: onlyMembers, skip: skipMembers, verbose, gitProtocol, createBranches },
          withProgress: true,
          ...(onMissingRef !== undefined ? { onMissingRef } : {}),
        })

        // Mark complete and finish UI
        yield* completeSyncProgress()
        yield* finishSyncProgressUIReact(ui)

        // Print generator output after progress UI completes
        const generatedFiles = getEnabledGenerators(config)
        if (generatedFiles.length > 0) {
          const genOutput = yield* Effect.promise(() =>
            renderToString(
              React.createElement(Box, null,
                React.createElement(Text, null, ''),
                React.createElement(Text, null, dryRun ? 'Would generate:' : 'Generated:'),
                ...generatedFiles.map((file) =>
                  React.createElement(Box, { flexDirection: 'row', key: file },
                    React.createElement(Text, null, '  '),
                    dryRun
                      ? React.createElement(Text, { dim: true }, '\u2192')
                      : React.createElement(Text, { color: 'green' }, '\u2713'),
                    React.createElement(Text, null, ' '),
                    React.createElement(Text, { bold: true }, file),
                  ),
                ),
              ),
            ),
          )
          yield* Console.log(genOutput)
        }

        // Check for sync errors and fail if any occurred
        const counts = countSyncResults(syncResult)
        if (counts.errors > 0) {
          const failedMembers = syncResult.results
            .filter((r) => r.status === 'error')
            .map((r) => r.name)
          return yield* new SyncFailedError({
            message: `${counts.errors} member(s) failed to sync`,
            errorCount: counts.errors,
            failedMembers,
          })
        }

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

        // Non-TTY mode doesn't use interactive prompts
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep, only: onlyMembers, skip: skipMembers, verbose, gitProtocol, createBranches },
        })

        // Get list of files that would be / were generated
        const generatedFiles = getEnabledGenerators(config)

        // Output results
        if (json) {
          console.log(JSON.stringify(flattenSyncResults(syncResult)))
          // In JSON mode, don't throw errors - the JSON output includes error info
          // and callers can check results for errors. Throwing would add extra output.
          return syncResult
        } else {
          // Render using the React SyncOutput component
          const output = yield* Effect.promise(() =>
            renderToString(
              React.createElement(SyncOutput, {
                name,
                root: root.value,
                results: syncResult.results,
                nestedMegarepos: syncResult.nestedMegarepos,
                deep,
                dryRun,
                frozen,
                pull,
                generatedFiles,
              }),
            ),
          )
          yield* Console.log(output)
        }

        // Check for sync errors and fail if any occurred (non-JSON mode only)
        const counts = countSyncResults(syncResult)
        if (counts.errors > 0) {
          const failedMembers = syncResult.results
            .filter((r) => r.status === 'error')
            .map((r) => r.name)
          return yield* new SyncFailedError({
            message: `${counts.errors} member(s) failed to sync`,
            errorCount: counts.errors,
            failedMembers,
          })
        }

        return syncResult
      }
    }).pipe(
      Effect.provide(Layer.merge(StoreLayer, SyncProgressReactLayer)),
      Effect.withSpan('megarepo/sync'),
    ),
).pipe(
  Cli.Command.withDescription(
    'Ensure members exist and update lock file to current worktree commits. Use --pull to fetch from remote.',
  ),
)
