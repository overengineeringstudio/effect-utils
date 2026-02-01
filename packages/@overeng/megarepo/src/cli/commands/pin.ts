/**
 * Pin / Unpin Commands
 *
 * Commands to pin and unpin members to specific refs.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { renderToString, Text } from '@overeng/tui-react'

import {
  buildSourceStringWithRef,
  CONFIG_FILE_NAME,
  getMemberPath,
  getSourceUrl,
  MegarepoConfig,
  parseSourceString,
  isRemoteSource,
} from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import {
  createEmptyLockFile,
  createLockedMember,
  getLockedMember,
  LOCK_FILE_NAME,
  pinMember,
  readLockFile,
  unpinMember,
  updateLockedMember,
  writeLockFile,
} from '../../lib/lock.ts'
import { classifyRef } from '../../lib/ref.ts'
import { Store, StoreLayer } from '../../lib/store.ts'
import { Cwd, findMegarepoRoot, outputOption } from '../context.ts'
import {
  NotInMegarepoError,
  MemberNotFoundError,
  InvalidSourceError,
  CannotUseLocalPathError,
  CannotGetCloneUrlError,
  MemberNotSyncedError,
  NoLockFileError,
} from '../errors.ts'
import { PinOutput, PinErrorOutput, PinWarningOutput } from '../renderers/PinOutput.tsx'

/**
 * Pin a member to a specific ref.
 * When -c is provided, switches to a different ref (branch, tag, or commit).
 * Without -c, pins to the current commit.
 * Pinned members won't be updated by `mr sync --pull` unless explicitly named.
 */
export const pinCommand = Cli.Command.make(
  'pin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to pin')),
    checkout: Cli.Options.text('checkout').pipe(
      Cli.Options.withAlias('c'),
      Cli.Options.withDescription('Ref to switch to (branch, tag, or commit SHA)'),
      Cli.Options.optional,
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be changed without making changes'),
      Cli.Options.withDefault(false),
    ),
    output: outputOption,
  },
  ({ member, checkout, dryRun, output }) => {
    const json = output === 'json' || output === 'ndjson'

    return Effect.gen(function* () {
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'not_in_megarepo' }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
      }

      const fs = yield* FileSystem.FileSystem
      const store = yield* Store

      // Load config to verify member exists
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      let config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      if (!(member in config.members)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: `Member '${member}' not found`,
            }),
          )
        } else {
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'member_not_found', member }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new MemberNotFoundError({ message: 'Member not found', member })
      }

      // Check if it's a local path (can't pin local paths)
      let sourceString = config.members[member]
      if (sourceString === undefined) {
        return yield* new MemberNotFoundError({ message: 'Member not found', member })
      }
      let source = parseSourceString(sourceString)
      if (source === undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'invalid_source',
              message: 'Invalid source string',
            }),
          )
        } else {
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'invalid_source' }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new InvalidSourceError({ message: 'Invalid source', source: sourceString })
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'local_path' }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new CannotUseLocalPathError({ message: 'Cannot pin local path' })
      }

      // Load or create lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lockFile = Option.getOrElse(lockFileOpt, () => createEmptyLockFile())

      const memberPath = getMemberPath({ megarepoRoot: root.value, name: member })
      const memberPathNormalized = memberPath.replace(/\/$/, '')

      // If -c is provided, switch to the new ref
      if (Option.isSome(checkout)) {
        const newRef = checkout.value

        // Get current ref from source string for display (source is guaranteed to be remote at this point)
        const currentRef =
          source.type !== 'path' ? Option.getOrElse(source.ref, () => 'main') : 'main'

        // Calculate new source string
        const newSourceString = buildSourceStringWithRef({ sourceString, newRef })
        const newSource = parseSourceString(newSourceString)!

        // Get paths for display
        const bareRepoPath = store.getBareRepoPath(newSource)
        const bareExists = yield* store.hasBareRepo(newSource)
        const refType = classifyRef(newRef)

        // Get worktree path for the new ref
        const worktreePath = store.getWorktreePath({
          source: newSource,
          ref: newRef,
          refType,
        })

        // Get current symlink target
        const currentLink = yield* fs
          .readLink(memberPathNormalized)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))

        // Check if worktree exists
        const worktreeExists = yield* store.hasWorktree({
          source: newSource,
          ref: newRef,
          refType,
        })

        // Get current lock info
        const currentLockEntry = Option.getOrUndefined(
          getLockedMember({ lockFile, memberName: member }),
        )
        const currentLockRef = currentLockEntry?.ref ?? currentRef
        const currentLockPinned = currentLockEntry?.pinned ?? false

        // For dry-run, show what would happen
        if (dryRun) {
          if (json) {
            console.log(
              JSON.stringify({
                status: 'dry_run',
                member,
                currentSource: sourceString,
                newSource: newSourceString,
                wouldClone: !bareExists,
                wouldCreateWorktree: !worktreeExists,
              }),
            )
          } else {
            const shortCurrentLink = currentLink ? shortenPath(currentLink) : '(none)'
            const shortNewLink = shortenPath(worktreePath.replace(/\/$/, ''))
            const lockChanges: string[] = []
            if (currentLockRef !== newRef) lockChanges.push(`ref: ${currentLockRef} → ${newRef}`)
            if (!currentLockPinned) lockChanges.push('pinned: true')

            const dryRunProps: NonNullable<Parameters<typeof PinOutput>[0]['dryRun']> = {
              currentSource: sourceString!, // Already validated non-undefined above
              newSource: newSourceString,
              currentSymlink: shortCurrentLink,
              newSymlink: shortNewLink,
              wouldClone: !bareExists,
              wouldCreateWorktree: !worktreeExists,
            }
            if (lockChanges.length > 0) {
              dryRunProps.lockChanges = lockChanges
            }

            const renderOutput = yield* Effect.promise(() =>
              renderToString({
                element: React.createElement(PinOutput, {
                  action: 'pin',
                  member,
                  status: 'dry_run',
                  ref: newRef,
                  dryRun: dryRunProps,
                }),
              }),
            )
            yield* Console.log(renderOutput)
          }
          return
        }

        // Actually perform the changes
        config = {
          ...config,
          members: {
            ...config.members,
            [member]: newSourceString,
          },
        }

        // Write updated config
        const newConfigContent = yield* Schema.encode(
          Schema.parseJson(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(configPath, newConfigContent + '\n')

        // Re-parse the source with the new ref
        sourceString = newSourceString
        source = parseSourceString(newSourceString)!

        if (!bareExists) {
          // Clone the bare repo
          const cloneUrl = getCloneUrl(source)
          if (cloneUrl === undefined) {
            return yield* new CannotGetCloneUrlError({ message: 'Cannot get clone URL' })
          }

          const repoBasePath = store.getRepoBasePath(source)
          yield* fs.makeDirectory(repoBasePath, { recursive: true })
          yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })

          if (!json) {
            const clonedOutput = yield* Effect.promise(() =>
              renderToString({
                element: React.createElement(Text, { dim: true }, `  Cloned ${cloneUrl}`),
              }),
            )
            yield* Console.log(clonedOutput)
          }
        } else {
          // Fetch to ensure we have the latest refs
          yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))
        }

        // Resolve commit
        let targetCommit: string

        if (refType === 'commit') {
          // It's already a commit SHA
          targetCommit = newRef
        } else {
          // Resolve the ref to a commit
          targetCommit = yield* Git.resolveRef({
            repoPath: bareRepoPath,
            ref: refType === 'tag' ? `refs/tags/${newRef}` : `refs/remotes/origin/${newRef}`,
          }).pipe(
            Effect.catchAll(() =>
              // Fallback: try resolving directly
              Git.resolveRef({ repoPath: bareRepoPath, ref: newRef }),
            ),
          )
        }

        if (!worktreeExists) {
          // Ensure parent directory exists
          const worktreeParent = EffectPath.ops.parent(worktreePath)
          if (worktreeParent !== undefined) {
            yield* fs.makeDirectory(worktreeParent, { recursive: true })
          }

          // Create the worktree
          if (refType === 'commit' || refType === 'tag') {
            yield* Git.createWorktreeDetached({
              repoPath: bareRepoPath,
              worktreePath,
              commit: targetCommit,
            })
          } else {
            // Branch: create worktree tracking the branch
            yield* Git.createWorktree({
              repoPath: bareRepoPath,
              worktreePath,
              branch: `origin/${newRef}`,
              createBranch: false,
            }).pipe(
              Effect.catchAll(() =>
                // Fallback: create detached at the resolved commit
                Git.createWorktreeDetached({
                  repoPath: bareRepoPath,
                  worktreePath,
                  commit: targetCommit,
                }),
              ),
            )
          }
        }

        // Update the symlink
        // Ensure repos directory exists
        const reposDir = EffectPath.ops.parent(memberPath)
        if (reposDir !== undefined) {
          yield* fs.makeDirectory(reposDir, { recursive: true })
        }

        if (currentLink !== null) {
          yield* fs.remove(memberPathNormalized)
        }
        yield* fs.symlink(worktreePath.replace(/\/$/, ''), memberPathNormalized)

        // Update lock file with new ref
        const url = getSourceUrl(source)
        if (url !== undefined) {
          lockFile = updateLockedMember({
            lockFile,
            memberName: member,
            member: createLockedMember({
              url,
              ref: newRef,
              commit: targetCommit,
              pinned: true,
            }),
          })
          yield* writeLockFile({ lockPath, lockFile })
        }

        if (json) {
          console.log(
            JSON.stringify({
              status: 'pinned',
              member,
              ref: newRef,
              commit: targetCommit,
            }),
          )
        } else {
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinOutput, {
                action: 'pin',
                member,
                status: 'success',
                ref: newRef,
                commit: targetCommit,
              }),
            }),
          )
          yield* Console.log(renderOutput)
        }

        return
      }

      // No -c provided: pin to current commit (existing behavior)
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'not_synced', member }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new MemberNotSyncedError({ message: 'Member not synced', member })
      }

      // Check if already pinned (only when not switching refs)
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinOutput, {
                action: 'pin',
                member,
                status: 'already_pinned',
                commit: lockedMember.commit,
              }),
            }),
          )
          yield* Console.log(renderOutput)
        }
        return
      }

      // Get paths for display and dry-run
      const commitWorktreePath = store.getWorktreePath({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      const commitWorktreeExists = yield* store.hasWorktree({
        source,
        ref: lockedMember.commit,
        refType: 'commit',
      })

      const currentLink = yield* fs
        .readLink(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))

      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* store.hasBareRepo(source)

      // For dry-run, show what would happen
      if (dryRun) {
        if (json) {
          console.log(
            JSON.stringify({
              status: 'dry_run',
              member,
              commit: lockedMember.commit,
              wouldCreateWorktree: !commitWorktreeExists && bareExists,
            }),
          )
        } else {
          const wouldChangeSymlink =
            currentLink !== null &&
            currentLink.replace(/\/$/, '') !== commitWorktreePath.replace(/\/$/, '')

          const dryRunProps: NonNullable<Parameters<typeof PinOutput>[0]['dryRun']> = {
            lockChanges: ['pinned: false → true'],
            wouldCreateWorktree: !commitWorktreeExists && bareExists,
            worktreeNotAvailable: !commitWorktreeExists && !bareExists,
          }
          if (wouldChangeSymlink) {
            dryRunProps.currentSymlink = shortenPath(currentLink)
            dryRunProps.newSymlink = shortenPath(commitWorktreePath.replace(/\/$/, ''))
          }

          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinOutput, {
                action: 'pin',
                member,
                status: 'dry_run',
                commit: lockedMember.commit,
                dryRun: dryRunProps,
              }),
            }),
          )
          yield* Console.log(renderOutput)
        }
        return
      }

      // Actually perform the changes
      lockFile = pinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      // If the commit worktree doesn't exist, create it
      if (!commitWorktreeExists) {
        if (!bareExists) {
          // Bare repo doesn't exist, can't create worktree - warn user
          if (!json) {
            const renderOutput = yield* Effect.promise(() =>
              renderToString({
                element: React.createElement(PinWarningOutput, {
                  warning: 'worktree_not_available',
                }),
              }),
            )
            yield* Console.log(renderOutput)
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
        if (
          currentLink !== null &&
          currentLink.replace(/\/$/, '') !== commitWorktreePath.replace(/\/$/, '')
        ) {
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
        const renderOutput = yield* Effect.promise(() =>
          renderToString({
            element: React.createElement(PinOutput, {
              action: 'pin',
              member,
              status: 'success',
              commit: lockedMember.commit,
            }),
          }),
        )
        yield* Console.log(renderOutput)
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/pin'))
  },
).pipe(Cli.Command.withDescription('Pin a member to a specific ref'))

/**
 * Get the git clone URL for a member source
 */
const getCloneUrl = (source: ReturnType<typeof parseSourceString>): string | undefined => {
  if (source === undefined) return undefined
  switch (source.type) {
    case 'github':
      return `git@github.com:${source.owner}/${source.repo}.git`
    case 'url':
      return source.url
    case 'path':
      return undefined
  }
}

/**
 * Shorten a path for display by replacing home directory with ~
 * and keeping only the last few path components if too long
 */
const shortenPath = (path: string): string => {
  const home = process.env['HOME'] ?? ''
  let shortened = path
  if (home && shortened.startsWith(home)) {
    shortened = '~' + shortened.slice(home.length)
  }
  // If still too long, show .../<last-3-components>
  const parts = shortened.split('/')
  if (parts.length > 5) {
    shortened = '.../' + parts.slice(-3).join('/')
  }
  return shortened
}

/**
 * Unpin a member, allowing it to be updated by `mr update`.
 */
export const unpinCommand = Cli.Command.make(
  'unpin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to unpin')),
    output: outputOption,
  },
  ({ member, output }) => {
    const json = output === 'json' || output === 'ndjson'

    return Effect.gen(function* () {
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'not_in_megarepo' }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'member_not_found', member }),
            }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new MemberNotFoundError({ message: 'Member not found', member })
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({ element: React.createElement(PinErrorOutput, { error: 'no_lock' }) }),
          )
          yield* Console.error(renderOutput)
        }
        return yield* new NoLockFileError({ message: 'No lock file' })
      }
      let lockFile = lockFileOpt.value

      // Check if member is in lock file
      const lockedMember = Option.getOrUndefined(getLockedMember({ lockFile, memberName: member }))
      if (lockedMember === undefined) {
        if (json) {
          console.log(JSON.stringify({ status: 'not_in_lock', member }))
        } else {
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinErrorOutput, { error: 'not_in_lock', member }),
            }),
          )
          yield* Console.log(renderOutput)
        }
        return
      }

      // Check if already unpinned
      if (!lockedMember.pinned) {
        if (json) {
          console.log(JSON.stringify({ status: 'already_unpinned', member }))
        } else {
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinOutput, {
                action: 'unpin',
                member,
                status: 'already_unpinned',
              }),
            }),
          )
          yield* Console.log(renderOutput)
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
          const renderOutput = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(PinWarningOutput, {
                warning: 'member_removed_from_config',
                member,
              }),
            }),
          )
          yield* Console.log(renderOutput)
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
            if (
              currentLink !== null &&
              currentLink.replace(/\/$/, '') !== refWorktreePath.replace(/\/$/, '')
            ) {
              yield* fs.remove(memberPathNormalized)
              yield* fs.symlink(refWorktreePath.replace(/\/$/, ''), memberPathNormalized)
            }
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ status: 'unpinned', member }))
      } else {
        const renderOutput = yield* Effect.promise(() =>
          renderToString({
            element: React.createElement(PinOutput, { action: 'unpin', member, status: 'success' }),
          }),
        )
        yield* Console.log(renderOutput)
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/unpin'))
  },
).pipe(Cli.Command.withDescription('Unpin a member to allow updates'))
