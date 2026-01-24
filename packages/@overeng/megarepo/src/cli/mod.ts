/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { Command, FileSystem, type Error as PlatformError } from '@effect/platform'
import { Console, Context, Effect, Fiber, Layer, Option, type ParseResult, Schema, Stream, SubscriptionRef } from 'effect'

import {
  createProgressListState,
  finishProgressList,
  formatElapsed,
  isTTY,
  kv,
  markActive,
  markError,
  markSuccess,
  separator,
  startProgressList,
  startSpinner,
  styled,
  symbols,
  updateProgressList,
} from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import {
  CONFIG_FILE_NAME,
  ENV_VARS,
  getMemberPath,
  getMembersRoot,
  getSourceRef,
  getSourceUrl,
  isRemoteSource,
  MegarepoConfig,
  MEMBER_ROOT_DIR,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../lib/config.ts'
import { generateNix, type NixGeneratorError } from '../lib/generators/nix/mod.ts'
import { generateSchema } from '../lib/generators/schema.ts'
import { generateVscode } from '../lib/generators/vscode.ts'
import * as Git from '../lib/git.ts'
import { MR_VERSION } from '../lib/version.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  getLockedMember,
  type LockFile,
  LOCK_FILE_NAME,
  pinMember,
  readLockFile,
  syncLockWithConfig,
  unpinMember,
  upsertLockedMember,
  writeLockFile,
} from '../lib/lock.ts'
import { classifyRef } from '../lib/ref.ts'
import { Store, StoreLayer } from '../lib/store.ts'
import {
  countSyncResults,
  flattenSyncResults,
  getCloneUrl,
  syncMember,
  type MegarepoSyncResult,
  type MemberSyncResult,
} from '../lib/sync/mod.ts'
import {
  outputLines,
  renderStatus,
  renderSync,
  type MemberStatus,
  type GitStatus,
} from './renderers/mod.ts'
import {
  SyncProgress,
  SyncProgressEmpty,
  setMemberSyncing,
  applySyncResult,
  completeSyncProgress,
  startSyncProgressUI,
  finishSyncProgressUI,
  type SyncProgressService,
} from './progress/mod.ts'

// Import extracted commands
import {
  addCommand,
  envCommand,
  execCommand,
  initCommand,
  lsCommand,
  pinCommand,
  unpinCommand,
  rootCommand,
  statusCommand,
  syncCommand,
  syncMegarepo,
  NotInMegarepoError,
  LockFileRequiredError,
  StaleLockFileError,
} from './commands/mod.ts'

// Re-export context for use by other modules
export { Cwd, createSymlink, findMegarepoRoot, findNearestMegarepoRoot, jsonOption } from './context.ts'

// Import context for remaining commands not yet extracted
import { Cwd, findMegarepoRoot, jsonOption } from './context.ts'

// =============================================================================
// Update Command
// =============================================================================

/** Member update result */
interface MemberUpdateResult {
  readonly name: string
  readonly status: 'updated' | 'skipped' | 'pinned' | 'error'
  readonly message?: string | undefined
  readonly oldCommit?: string | undefined
  readonly newCommit?: string | undefined
}

/**
 * Update a single member: fetch latest, update worktree, update lock file.
 * Respects pinned status unless force is true.
 */
const updateMember = ({
  name,
  sourceString,
  _megarepoRoot,
  lockFile,
  force,
}: {
  name: string
  sourceString: string
  _megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  force: boolean
}) =>
  Effect.gen(function* () {
    const _fs = yield* FileSystem.FileSystem
    const store = yield* Store

    // Parse source string
    const source = parseSourceString(sourceString)
    if (source === undefined) {
      return {
        name,
        status: 'error',
        message: `Invalid source string: ${sourceString}`,
      } satisfies MemberUpdateResult
    }

    // Skip local path sources - they don't need updating
    if (source.type === 'path') {
      return {
        name,
        status: 'skipped',
        message: 'Local path (nothing to update)',
      } satisfies MemberUpdateResult
    }

    // Check if member is pinned (skip unless force)
    const lockedMember = lockFile?.members[name]
    if (lockedMember?.pinned && !force) {
      return {
        name,
        status: 'pinned',
        message: `Pinned at ${lockedMember.commit.slice(0, 7)}`,
        oldCommit: lockedMember.commit,
        newCommit: lockedMember.commit,
      } satisfies MemberUpdateResult
    }

    // Check if bare repo exists
    const bareRepoPath = store.getBareRepoPath(source)
    const bareExists = yield* store.hasBareRepo(source)

    if (!bareExists) {
      return {
        name,
        status: 'skipped',
        message: 'Not synced yet (no bare repo)',
      } satisfies MemberUpdateResult
    }

    // Determine the ref to update
    const sourceRef = getSourceRef(source)
    let targetRef: string
    if (Option.isSome(sourceRef)) {
      targetRef = sourceRef.value
    } else if (lockedMember !== undefined) {
      targetRef = lockedMember.ref
    } else {
      // Need to determine default branch
      const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
      targetRef = Option.getOrElse(defaultBranch, () => 'main')
    }

    // For commits and tags, nothing to update
    const refType = classifyRef(targetRef)
    if (refType === 'commit' || refType === 'tag') {
      return {
        name,
        status: 'skipped',
        message: refType === 'commit' ? 'Pinned to specific commit' : 'Pinned to tag',
        oldCommit: lockedMember?.commit,
        newCommit: lockedMember?.commit,
      } satisfies MemberUpdateResult
    }

    // Fetch latest from remote
    yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))

    // Resolve branch to new commit
    const newCommit = yield* Git.resolveRef({
      repoPath: bareRepoPath,
      ref: `refs/remotes/origin/${targetRef}`,
    }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))

    const oldCommit = lockedMember?.commit

    // Check if there's anything to update
    if (oldCommit === newCommit) {
      return {
        name,
        status: 'skipped',
        message: 'Already up to date',
        oldCommit,
        newCommit,
      } satisfies MemberUpdateResult
    }

    // Update the worktree
    const worktreePath = store.getWorktreePath({ source, ref: targetRef })
    const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef })

    if (worktreeExists) {
      // Try to update the worktree
      yield* Git.checkoutWorktree({ worktreePath, ref: newCommit }).pipe(
        Effect.catchAll(() =>
          // If checkout fails, try a hard reset (detached worktrees)
          Effect.gen(function* () {
            const cmd = Command.make('git', 'reset', '--hard', newCommit).pipe(
              Command.workingDirectory(worktreePath),
            )
            yield* Command.string(cmd)
          }),
        ),
      )
    }

    return {
      name,
      status: 'updated',
      oldCommit,
      newCommit,
    } satisfies MemberUpdateResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies MemberUpdateResult),
    ),
  )

/** Update (pull) repos - fetch latest refs and update worktrees */
const updateCommand = Cli.Command.make(
  'update',
  {
    json: jsonOption,
    member: Cli.Options.text('member').pipe(
      Cli.Options.withAlias('m'),
      Cli.Options.withDescription('Update only this member'),
      Cli.Options.optional,
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Update even if pinned'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, member, force }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Load lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lockFile = Option.getOrUndefined(lockFileOpt)

      // Filter members if specific one requested
      const membersToUpdate = Option.match(member, {
        onNone: () => Object.entries(config.members),
        onSome: (m) => {
          const sourceString = config.members[m]
          return sourceString !== undefined ? [[m, sourceString] as const] : []
        },
      })

      if (membersToUpdate.length === 0) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: MemberUpdateResult[] = []

      for (const [name, sourceString] of membersToUpdate) {
        const result = yield* updateMember({
          name,
          sourceString,
          _megarepoRoot: root.value,
          lockFile,
          force,
        })
        results.push(result)

        if (!json) {
          const statusSymbol =
            result.status === 'error'
              ? styled.red(symbols.cross)
              : result.status === 'updated'
                ? styled.green(symbols.check)
                : result.status === 'pinned'
                  ? styled.yellow('⊘')
                  : styled.dim(symbols.check)

          let statusText: string
          if (result.status === 'updated' && result.oldCommit && result.newCommit) {
            statusText = `${result.oldCommit.slice(0, 7)} → ${result.newCommit.slice(0, 7)}`
          } else if (result.status === 'pinned') {
            statusText = `pinned${result.message ? ` (${result.message})` : ''}`
          } else if (result.message) {
            statusText = result.message
          } else {
            statusText = result.status
          }

          yield* Console.log(
            `${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${statusText})`)}`,
          )
        }

        // Update lock file entry if we got a new commit
        if (
          result.status === 'updated' &&
          result.newCommit !== undefined &&
          lockFile !== undefined
        ) {
          const source = parseSourceString(sourceString)
          if (source !== undefined && isRemoteSource(source)) {
            const sourceRef = getSourceRef(source)
            const url = getSourceUrl(source) ?? sourceString
            const ref = Option.isSome(sourceRef)
              ? sourceRef.value
              : (lockFile.members[name]?.ref ?? 'main')
            const existingLocked = lockFile.members[name]

            lockFile = upsertLockedMember({
              lockFile,
              memberName: name,
              update: {
                url,
                ref,
                commit: result.newCommit,
                pinned: existingLocked?.pinned ?? false,
              },
            })
          }
        }
      }

      // Write updated lock file
      if (lockFile !== undefined) {
        yield* writeLockFile({ lockPath, lockFile })
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      } else {
        const updatedCount = results.filter((r) => r.status === 'updated').length
        const skippedCount = results.filter((r) => r.status === 'skipped').length
        const pinnedCount = results.filter((r) => r.status === 'pinned').length
        const errorCount = results.filter((r) => r.status === 'error').length

        yield* Console.log('')
        const parts: string[] = []
        if (updatedCount > 0) parts.push(`${updatedCount} updated`)
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
        if (pinnedCount > 0) parts.push(`${pinnedCount} pinned`)
        yield* Console.log(styled.dim(parts.join(', ')))

        if (errorCount > 0) {
          yield* Console.log(styled.red(`${errorCount} error(s)`))
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/update')),
).pipe(Cli.Command.withDescription('Update members to latest remote refs'))

// =============================================================================
// Store Commands
// =============================================================================

/** List repos in the store */
const storeLsCommand = Cli.Command.make('ls', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()

    if (json) {
      console.log(JSON.stringify({ repos }))
    } else {
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')

      if (repos.length === 0) {
        yield* Console.log(styled.dim('(empty)'))
      } else {
        yield* Console.log(separator())
        yield* Console.log('')
        for (const repo of repos) {
          yield* Console.log(`${styled.green(symbols.check)} ${repo.relativePath}`)
        }
        yield* Console.log('')
        yield* Console.log(styled.dim(`${repos.length} repositories`))
      }
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/ls'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('List repositories in the store'))

/** Fetch all repos in the store */
const storeFetchCommand = Cli.Command.make('fetch', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()
    const startTime = Date.now()

    // For TTY: use live progress rendering
    // For non-TTY (piped): just collect results silently
    const useLiveProgress = !json && isTTY()

    // Create progress state
    const progressState = createProgressListState(
      repos.map((repo) => ({ id: repo.relativePath, label: repo.relativePath })),
    )

    if (useLiveProgress) {
      // Print header
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')
      yield* Console.log(separator())
      yield* Console.log('')

      // Start progress display
      startProgressList(progressState)
      startSpinner(progressState, 80)
    }

    // Fetch repos with limited concurrency for visible progress
    const results = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          // Mark as active
          if (useLiveProgress) {
            markActive(progressState, repo.relativePath, 'fetching...')
            updateProgressList(progressState)
          }

          // The bare repo is in the .bare/ subdirectory
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )

          const result = yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
            Effect.map(() => {
              if (useLiveProgress) {
                markSuccess(progressState, repo.relativePath)
                updateProgressList(progressState)
              }
              return { path: repo.relativePath, status: 'fetched' as const }
            }),
            Effect.catchAll((error) => {
              const message = error instanceof Error ? error.message : String(error)
              if (useLiveProgress) {
                markError(progressState, repo.relativePath, message)
                updateProgressList(progressState)
              }
              return Effect.succeed({
                path: repo.relativePath,
                status: 'error' as const,
                message,
              })
            }),
          )

          return result
        }),
      ),
      { concurrency: 4 },
    )

    const elapsed = Date.now() - startTime

    if (useLiveProgress) {
      // Finish progress display
      finishProgressList(progressState)

      // Print summary
      const fetchedCount = results.filter((r) => r.status === 'fetched').length
      const errorCount = results.filter((r) => r.status === 'error').length
      const parts: string[] = [`${fetchedCount} fetched`]
      if (errorCount > 0) {
        parts.push(styled.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`))
      }
      parts.push(formatElapsed(elapsed))
      yield* Console.log(styled.dim(parts.join(' · ')))
    } else if (json) {
      console.log(JSON.stringify({ results }))
    } else {
      // Non-TTY: print final results only
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')
      yield* Console.log(separator())
      yield* Console.log('')

      for (const result of results) {
        const symbol =
          result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
        const suffix =
          result.status === 'error' && result.message
            ? styled.dim(` (${result.message})`)
            : ''
        yield* Console.log(`${symbol} ${result.path}${suffix}`)
      }

      yield* Console.log('')
      const fetchedCount = results.filter((r) => r.status === 'fetched').length
      const errorCount = results.filter((r) => r.status === 'error').length
      const parts: string[] = [`${fetchedCount} fetched`]
      if (errorCount > 0) {
        parts.push(styled.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`))
      }
      parts.push(formatElapsed(elapsed))
      yield* Console.log(styled.dim(parts.join(' · ')))
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/fetch')),
).pipe(Cli.Command.withDescription('Fetch all repositories in the store'))

/** GC result for a single worktree */
interface GcWorktreeResult {
  readonly repo: string
  readonly ref: string
  readonly path: string
  readonly status: 'removed' | 'skipped_dirty' | 'skipped_in_use' | 'error'
  readonly message?: string
}

/**
 * Garbage collect unused worktrees from the store.
 * Removes worktrees that are not referenced by any megarepo's lock file.
 */
const storeGcCommand = Cli.Command.make(
  'gc',
  {
    json: jsonOption,
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
  ({ json, dryRun, force, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      // Get lock file from current megarepo (if any)
      const root = yield* findMegarepoRoot(cwd)
      let lockFile: LockFile | undefined
      let inUsePaths = new Set<string>()

      if (Option.isSome(root) && !all) {
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
            if (source === undefined || !isRemoteSource(source)) continue

            const lockedMember = lockFile.members[name]
            if (lockedMember === undefined) continue

            // Mark the worktree path as in use
            const worktreePath = store.getWorktreePath({ source, ref: lockedMember.ref })
            inUsePaths.add(worktreePath)
          }
        }
      }

      if (!json && !all && Option.isNone(root)) {
        yield* Console.log(
          styled.dim('Not in a megarepo - all worktrees will be considered unused'),
        )
        yield* Console.log('')
      }

      // List all repos and their worktrees
      const repos = yield* store.listRepos()
      const results: GcWorktreeResult[] = []

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
          if (inUsePaths.has(worktree.path)) {
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
              Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 }),
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

      // Output results
      if (json) {
        console.log(
          JSON.stringify({
            dryRun,
            results,
            summary: {
              removed: results.filter((r) => r.status === 'removed').length,
              skippedDirty: results.filter((r) => r.status === 'skipped_dirty').length,
              skippedInUse: results.filter((r) => r.status === 'skipped_in_use').length,
              errors: results.filter((r) => r.status === 'error').length,
            },
          }),
        )
      } else {
        const removed = results.filter((r) => r.status === 'removed')
        const skippedDirty = results.filter((r) => r.status === 'skipped_dirty')
        const skippedInUse = results.filter((r) => r.status === 'skipped_in_use')

        // Header
        yield* Console.log(styled.bold('store gc'))
        yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
        if (dryRun) {
          yield* Console.log(styled.dim('  mode: dry run'))
        }
        yield* Console.log('')
        yield* Console.log(separator())
        yield* Console.log('')

        if (results.length === 0) {
          yield* Console.log(styled.dim('No worktrees found'))
        } else {
          // Removed worktrees
          for (const r of removed) {
            const verb = dryRun ? 'would remove' : 'removed'
            yield* Console.log(
              `${styled.green(symbols.check)} ${r.repo}refs/${r.ref} ${styled.dim(`(${verb})`)}`,
            )
          }

          // Skipped dirty worktrees
          for (const r of skippedDirty) {
            yield* Console.log(
              `${styled.yellow(symbols.circle)} ${r.repo}refs/${r.ref} ${styled.dim(`(${r.message})`)}`,
            )
          }

          // Skipped in-use worktrees (only show if few results)
          if (skippedInUse.length > 0 && skippedInUse.length <= 5) {
            for (const r of skippedInUse) {
              yield* Console.log(
                `${styled.dim(symbols.check)} ${styled.dim(`${r.repo}refs/${r.ref}`)} ${styled.dim('(in use)')}`,
              )
            }
          }
        }

        // Summary
        yield* Console.log('')
        const parts: string[] = []
        if (removed.length > 0) parts.push(`${removed.length} ${dryRun ? 'would be ' : ''}removed`)
        if (skippedDirty.length > 0) parts.push(`${skippedDirty.length} skipped (dirty)`)
        if (skippedInUse.length > 0) parts.push(`${skippedInUse.length} in use`)
        yield* Console.log(styled.dim(parts.length > 0 ? parts.join(' · ') : 'Nothing to clean up'))

        if (skippedDirty.length > 0 && !force) {
          yield* Console.log(styled.dim('Use --force to remove dirty worktrees'))
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/gc')),
).pipe(Cli.Command.withDescription('Garbage collect unused worktrees'))

/** Store subcommand group */
const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([storeLsCommand, storeFetchCommand, storeGcCommand]),
  Cli.Command.withDescription('Manage the shared git store'),
)

// =============================================================================
// Generate Command
// =============================================================================

/** Generate Nix workspace */
interface NixGenerateTree {
  readonly root: AbsoluteDirPath
  readonly result: {
    readonly workspaceRoot: AbsoluteDirPath
    readonly flakePath: AbsoluteFilePath
    readonly envrcPath: AbsoluteFilePath
  }
  readonly nested: readonly NixGenerateTree[]
}

const flattenNixGenerateTree = (
  tree: NixGenerateTree,
): Array<NixGenerateTree['result'] & { root: AbsoluteDirPath }> => [
  { root: tree.root, ...tree.result },
  ...tree.nested.flatMap(flattenNixGenerateTree),
]

const generateNixForRoot = Effect.fn('megarepo/generate/nix/root')(function* ({
  outermostRoot,
  currentRoot,
  deep,
  json,
  depth,
  visited,
}: {
  outermostRoot: AbsoluteDirPath
  currentRoot: AbsoluteDirPath
  deep: boolean
  json: boolean
  depth: number
  visited: Set<string>
}): Effect.Effect<Option.Option<NixGenerateTree>, NixGeneratorError> {
  const rootKey = currentRoot.replace(/\/$/, '')
  if (visited.has(rootKey)) {
    return Option.none()
  }
  visited.add(rootKey)

  const indent = '  '.repeat(depth)
  const fs = yield* FileSystem.FileSystem
  const configPath = EffectPath.ops.join(
    currentRoot,
    EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
  )
  const configContent = yield* fs.readFileString(configPath)
  const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

  if (!json && depth > 0) {
    yield* Console.log(`${indent}${styled.dim(`Generating ${currentRoot}...`)}`)
  }

  const result = yield* generateNix({
    megarepoRootOutermost: outermostRoot,
    megarepoRootNearest: currentRoot,
    config,
  })

  if (!json) {
    yield* Console.log(
      `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
    )
    yield* Console.log(
      `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
    )
  }

  const nested: NixGenerateTree[] = []
  if (deep) {
    const nestedRoots: AbsoluteDirPath[] = []
    for (const [name] of Object.entries(config.members)) {
      const memberPath = getMemberPath({ megarepoRoot: currentRoot, name })
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const hasNestedConfig = yield* fs
        .exists(nestedConfigPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (hasNestedConfig) {
        nestedRoots.push(
          EffectPath.unsafe.absoluteDir(memberPath.endsWith('/') ? memberPath : `${memberPath}/`),
        )
      }
    }

    if (nestedRoots.length > 0 && !json) {
      yield* Console.log('')
      yield* Console.log(`${indent}${styled.bold('Generating nested megarepos...')}`)
    }

    for (const nestedRoot of nestedRoots) {
      const nestedResult = yield* generateNixForRoot({
        outermostRoot,
        currentRoot: nestedRoot,
        deep,
        json,
        depth: depth + 1,
        visited,
      })
      if (Option.isSome(nestedResult)) {
        nested.push(nestedResult.value)
      }
    }
  }

  return Option.some({
    root: currentRoot,
    result,
    nested,
  })
})

const generateNixCommand = Cli.Command.make(
  'nix',
  {
    json: jsonOption,
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively generate nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, deep }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const result = yield* generateNixForRoot({
        outermostRoot: root.value,
        currentRoot: root.value,
        deep,
        json,
        depth: 0,
        visited: new Set(),
      })

      if (Option.isNone(result)) return

      if (json) {
        console.log(
          JSON.stringify({
            status: 'generated',
            results: flattenNixGenerateTree(result.value),
          }),
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/nix')),
).pipe(Cli.Command.withDescription('Generate local Nix workspace'))

/** Generate VSCode workspace file */
const generateVscodeCommand = Cli.Command.make(
  'vscode',
  {
    json: jsonOption,
    exclude: Cli.Options.text('exclude').pipe(
      Cli.Options.withDescription('Comma-separated list of members to exclude'),
      Cli.Options.optional,
    ),
  },
  ({ json, exclude }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const excludeList = Option.map(exclude, (e) => e.split(',').map((s) => s.trim()))

      const result = yield* generateVscode({
        megarepoRoot: root.value,
        config,
        ...(Option.isSome(excludeList) ? { exclude: excludeList.value } : {}),
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/vscode')),
).pipe(Cli.Command.withDescription('Generate VS Code workspace file'))

/** Generate JSON Schema */
const generateSchemaCommand = Cli.Command.make(
  'schema',
  {
    json: jsonOption,
    output: Cli.Options.text('output').pipe(
      Cli.Options.withAlias('o'),
      Cli.Options.withDescription('Output path (relative to megarepo root)'),
      Cli.Options.withDefault('schema/megarepo.schema.json'),
    ),
  },
  ({ json, output }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const result = yield* generateSchema({
        megarepoRoot: root.value,
        config,
        outputPath: output,
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Generated ${styled.bold(output)}`)
      }
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
).pipe(Cli.Command.withDescription('Generate JSON schema for megarepo.json'))

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
      }
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    // Load config
    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      root.value,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    const results: Array<{ generator: string; path: string }> = []

    // Generate Nix workspace (default: disabled)
    const nixEnabled = config.generators?.nix?.enabled === true
    if (nixEnabled) {
      const nixResult = yield* generateNixForRoot({
        outermostRoot: root.value,
        currentRoot: root.value,
        deep: false,
        json,
        depth: 0,
        visited: new Set(),
      })
      if (Option.isSome(nixResult)) {
        results.push({ generator: 'nix', path: nixResult.value.result.workspaceRoot })
      }
      if (!json) {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
        )
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
        )
      }
    }

    // Generate VSCode workspace (default: disabled)
    const vscodeEnabled = config.generators?.vscode?.enabled === true
    if (vscodeEnabled) {
      const vscodeResult = yield* generateVscode({
        megarepoRoot: root.value,
        config,
      })
      results.push({ generator: 'vscode', path: vscodeResult.path })
      if (!json) {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }

    // Generate JSON schema (always enabled for editor support)
    const schemaResult = yield* generateSchema({
      megarepoRoot: root.value,
      config,
    })
    results.push({ generator: 'schema', path: schemaResult.path })
    if (!json) {
      yield* Console.log(
        `${styled.green(symbols.check)} Generated ${styled.bold('schema/megarepo.schema.json')}`,
      )
    }

    if (json) {
      console.log(JSON.stringify({ status: 'generated', results }))
    } else {
      yield* Console.log('')
      yield* Console.log(styled.dim(`Generated ${results.length} file(s)`))
    }
  }).pipe(Effect.withSpan('megarepo/generate/all')),
).pipe(Cli.Command.withDescription('Generate all configured outputs'))

/** Generate subcommand group */
const generateCommand = Cli.Command.make('generate', {}).pipe(
  Cli.Command.withSubcommands([
    generateAllCommand,
    generateNixCommand,
    generateSchemaCommand,
    generateVscodeCommand,
  ]),
  Cli.Command.withDescription('Generate configuration files'),
)

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const mrCommand = Cli.Command.make('mr', {}).pipe(
  Cli.Command.withSubcommands([
    initCommand,
    rootCommand,
    envCommand,
    statusCommand,
    lsCommand,
    syncCommand,
    addCommand,
    updateCommand,
    pinCommand,
    unpinCommand,
    execCommand,
    storeCommand,
    generateCommand,
  ]),
  Cli.Command.withDescription('Multi-repo workspace management tool'),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: MR_VERSION,
})(process.argv).pipe(Effect.provide(Cwd.live))
