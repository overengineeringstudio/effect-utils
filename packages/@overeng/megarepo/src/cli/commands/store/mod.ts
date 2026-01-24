/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

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
import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { withJsonMode } from '@overeng/utils/node'

import { CONFIG_FILE_NAME, MegarepoConfig, parseSourceString, isRemoteSource } from '../../../lib/config.ts'
import * as Git from '../../../lib/git.ts'
import { type LockFile, LOCK_FILE_NAME, readLockFile } from '../../../lib/lock.ts'
import { Store, StoreLayer } from '../../../lib/store.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../../context.ts'

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
export const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([storeLsCommand, storeFetchCommand, storeGcCommand]),
  Cli.Command.withDescription('Manage the shared git store'),
)
