/**
 * Pin / Unpin Commands
 *
 * Commands to pin and unpin members to specific commits.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Layer, Option, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME,
  getMemberPath,
  MegarepoConfig,
  parseSourceString,
  isRemoteSource,
} from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import {
  createEmptyLockFile,
  getLockedMember,
  LOCK_FILE_NAME,
  pinMember,
  readLockFile,
  unpinMember,
  writeLockFile,
} from '../../lib/lock.ts'
import { Store, StoreLayer } from '../../lib/store.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

/**
 * Pin a member to its current commit.
 * Pinned members won't be updated by `mr update` unless explicitly named.
 */
export const pinCommand = Cli.Command.make(
  'pin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to pin')),
    json: jsonOption,
  },
  ({ member, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

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
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config to verify member exists
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      if (!(member in config.members)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: `Member '${member}' not found`,
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      // Check if it's a local path (can't pin local paths)
      const sourceString = config.members[member]
      if (sourceString === undefined) {
        return yield* Effect.fail(new Error('Member not found'))
      }
      const source = parseSourceString(sourceString)
      if (source === undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'invalid_source',
              message: 'Invalid source string',
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Invalid source string`)
        }
        return yield* Effect.fail(new Error('Invalid source'))
      }
      if (!isRemoteSource(source)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'local_path',
              message: 'Cannot pin local path members',
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Cannot pin local path members`)
        }
        return yield* Effect.fail(new Error('Cannot pin local path'))
      }

      // Load or create lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lockFile = Option.getOrElse(lockFileOpt, () => createEmptyLockFile())

      // Check if member is in lock file
      const lockedMember = Option.getOrUndefined(getLockedMember({ lockFile, memberName: member }))
      if (lockedMember === undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_synced',
              message: 'Member not synced yet. Run mr sync first.',
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not synced yet.`)
          yield* Console.log(styled.dim('  Run: mr sync'))
        }
        return yield* Effect.fail(new Error('Member not synced'))
      }

      // Check if already pinned
      if (lockedMember.pinned) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'already_pinned',
              member,
              commit: lockedMember.commit,
            }),
          )
        } else {
          yield* Console.log(
            styled.dim(
              `Member '${member}' is already pinned at ${lockedMember.commit.slice(0, 7)}`,
            ),
          )
        }
        return
      }

      // Pin the member
      lockFile = pinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      // Update the symlink to point to a commit-based worktree path
      // This ensures the pinned member stays at the exact commit
      const store = yield* Store
      const memberPath = getMemberPath({ megarepoRoot: root.value, name: member })
      const memberPathNormalized = memberPath.replace(/\/$/, '')

      // Get the commit-based worktree path
      const commitWorktreePath = store.getWorktreePath({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      // Check if worktree exists at commit path
      const commitWorktreeExists = yield* store.hasWorktree({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      // If the commit worktree doesn't exist, create it
      if (!commitWorktreeExists) {
        const bareRepoPath = store.getBareRepoPath(source)
        const bareExists = yield* store.hasBareRepo(source)

        if (!bareExists) {
          // Bare repo doesn't exist, can't create worktree - warn user
          if (!json) {
            yield* Console.log(
              styled.yellow(
                `${symbols.warning} Commit worktree not available (repo not in store). Run 'mr sync' to complete.`,
              ),
            )
          }
        } else {
          // Create the worktree parent directory
          const worktreeParent = EffectPath.ops.parent(commitWorktreePath)
          if (worktreeParent !== undefined) {
            yield* fs.makeDirectory(worktreeParent, { recursive: true })
          }

          // Create detached worktree at the pinned commit
          yield* Git.createWorktreeDetached({
            repoPath: bareRepoPath,
            worktreePath: commitWorktreePath,
            commit: lockedMember.commit,
          })
        }
      }

      // Check again if worktree exists (it may have been created above)
      const worktreeReady = yield* store.hasWorktree({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      if (worktreeReady) {
        // Update the symlink
        const currentLink = yield* fs
          .readLink(memberPathNormalized)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (currentLink !== null && currentLink.replace(/\/$/, '') !== commitWorktreePath.replace(/\/$/, '')) {
          yield* fs.remove(memberPathNormalized)
          yield* fs.symlink(commitWorktreePath.replace(/\/$/, ''), memberPathNormalized)
        }
      }

      if (json) {
        console.log(
          JSON.stringify({
            status: 'pinned',
            member,
            commit: lockedMember.commit,
          }),
        )
      } else {
        yield* Console.log(
          `${styled.green(symbols.check)} Pinned ${styled.bold(member)} at ${styled.dim(lockedMember.commit.slice(0, 7))}`,
        )
      }
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/pin'),
    ),
).pipe(Cli.Command.withDescription('Pin a member to its current commit'))

/**
 * Unpin a member, allowing it to be updated by `mr update`.
 */
export const unpinCommand = Cli.Command.make(
  'unpin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to unpin')),
    json: jsonOption,
  },
  ({ member, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

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
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config to verify member exists
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      if (!(member in config.members)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: `Member '${member}' not found`,
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      // Load lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      if (Option.isNone(lockFileOpt)) {
        if (json) {
          console.log(JSON.stringify({ error: 'no_lock', message: 'No lock file found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} No lock file found`)
        }
        return yield* Effect.fail(new Error('No lock file'))
      }
      let lockFile = lockFileOpt.value

      // Check if member is in lock file
      const lockedMember = Option.getOrUndefined(getLockedMember({ lockFile, memberName: member }))
      if (lockedMember === undefined) {
        if (json) {
          console.log(JSON.stringify({ status: 'not_in_lock', member }))
        } else {
          yield* Console.log(styled.dim(`Member '${member}' not in lock file`))
        }
        return
      }

      // Check if already unpinned
      if (!lockedMember.pinned) {
        if (json) {
          console.log(JSON.stringify({ status: 'already_unpinned', member }))
        } else {
          yield* Console.log(styled.dim(`Member '${member}' is not pinned`))
        }
        return
      }

      // Unpin the member
      lockFile = unpinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      // Check if it's a remote source and update the symlink back to ref-based path
      const sourceString = config.members[member]
      if (sourceString === undefined) {
        // Member was removed from config but still in lock file - warn user
        if (!json) {
          yield* Console.log(
            styled.yellow(
              `${symbols.warning} Member '${member}' was removed from config but still in lock file`,
            ),
          )
          yield* Console.log(
            styled.dim('  Consider running: mr sync --pull'),
          )
        }
      } else {
        const source = parseSourceString(sourceString)
        if (source !== undefined && isRemoteSource(source)) {
          const store = yield* Store
          const memberPath = getMemberPath({ megarepoRoot: root.value, name: member })
          const memberPathNormalized = memberPath.replace(/\/$/, '')

          // Get the ref-based worktree path (use the locked ref)
          const refWorktreePath = store.getWorktreePath({
            source,
            ref: lockedMember.ref,
            // Use undefined to let heuristics determine the type
          })

          // Check if worktree exists at ref path
          const refWorktreeExists = yield* store.hasWorktree({
            source,
            ref: lockedMember.ref,
          })

          // Update symlink if ref worktree exists and current link is different
          if (refWorktreeExists) {
            const currentLink = yield* fs
              .readLink(memberPathNormalized)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (currentLink !== null && currentLink.replace(/\/$/, '') !== refWorktreePath.replace(/\/$/, '')) {
              yield* fs.remove(memberPathNormalized)
              yield* fs.symlink(refWorktreePath.replace(/\/$/, ''), memberPathNormalized)
            }
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ status: 'unpinned', member }))
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Unpinned ${styled.bold(member)}`)
      }
    }).pipe(
      Effect.provide(StoreLayer),
      Effect.withSpan('megarepo/unpin'),
    ),
).pipe(Cli.Command.withDescription('Unpin a member to allow updates'))
