/**
 * Status Command
 *
 * Show workspace status and member states.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME,
  getMemberPath,
  isRemoteSource,
  MegarepoConfig,
  MEMBER_ROOT_DIR,
  parseSourceString,
} from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { checkLockStaleness, LOCK_FILE_NAME, readLockFile } from '../../lib/lock.ts'
import { extractRefFromSymlinkPath } from '../../lib/ref.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { NotInMegarepoError } from '../errors.ts'
import { StatusApp, StatusView } from '../renderers/StatusOutput/mod.ts'
import type {
  CommitDrift,
  GitStatus,
  MemberStatus,
  SymlinkDrift,
} from '../renderers/StatusOutput/mod.ts'

/**
 * Recursively scan members and build status tree.
 * @param megarepoRoot - Root path of the megarepo
 * @param all - Whether to recurse into nested megarepos
 * @param visited - Set of visited paths to prevent cycles
 */
const scanMembersRecursive = ({
  megarepoRoot,
  all,
  visited = new Set<string>(),
}: {
  megarepoRoot: AbsoluteDirPath
  all: boolean
  visited?: Set<string>
}): Effect.Effect<
  MemberStatus[],
  PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Prevent cycles
    const normalizedRoot = megarepoRoot.replace(/\/$/, '')
    if (visited.has(normalizedRoot)) {
      return []
    }
    visited.add(normalizedRoot)

    // Load config
    const configPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configExists = yield* fs.exists(configPath)
    if (!configExists) {
      return []
    }

    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    // Load lock file (optional)
    const lockPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    const lockFile = Option.getOrUndefined(lockFileOpt)

    // Build member status list
    const members: MemberStatus[] = []
    for (const [memberName, sourceString] of Object.entries(config.members)) {
      const memberPath = getMemberPath({ megarepoRoot, name: memberName })
      const source = parseSourceString(sourceString)
      const isLocal = source?.type === 'path'
      const lockedMember = lockFile?.members[memberName]

      // Check if symlink exists in repos/<member>
      const symlinkPath = memberPath.replace(/\/$/, '')
      const symlinkExists = yield* fs.exists(symlinkPath)

      // For remote members, also check if the underlying worktree exists
      // (symlink might exist but point to non-existent worktree)
      let memberExists = symlinkExists
      if (symlinkExists && !isLocal) {
        // Check if symlink target exists
        const targetExists = yield* fs.readLink(symlinkPath).pipe(
          Effect.flatMap((target) => fs.exists(target)),
          Effect.catchAll(() => Effect.succeed(false)),
        )
        memberExists = targetExists
      }

      // Check if this member is itself a megarepo
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const isMegarepo = memberExists
        ? yield* fs.exists(nestedConfigPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
        : false

      // Recursively scan nested members if this is a megarepo and --all is used
      let nestedMembers: readonly MemberStatus[] | undefined = undefined
      if (all && isMegarepo && memberExists) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') ? memberPath : `${memberPath}/`,
        )
        nestedMembers = yield* scanMembersRecursive({
          megarepoRoot: nestedRoot,
          all,
          visited,
        })
      }

      // Get git status if member exists
      let gitStatus: GitStatus | undefined = undefined
      let currentBranch: string | undefined = undefined
      let fullCommit: string | undefined = undefined
      if (memberExists) {
        // Check if it's a git repo first
        const isGit = yield* Git.isGitRepo(memberPath)
        if (isGit) {
          // Get worktree status (dirty, unpushed)
          const worktreeStatus = yield* Git.getWorktreeStatus(memberPath).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                isDirty: false,
                hasUnpushed: false,
                changesCount: 0,
              }),
            ),
          )

          // Get current branch
          const branchOpt = yield* Git.getCurrentBranch(memberPath).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          const branch = Option.getOrElse(branchOpt, () => 'HEAD')
          currentBranch = branch !== 'HEAD' ? branch : undefined

          // Get current commit (full SHA for drift detection, short for display)
          fullCommit = yield* Git.getCurrentCommit(memberPath).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          )
          const shortRev = fullCommit?.slice(0, 7)

          gitStatus = {
            isDirty: worktreeStatus.isDirty,
            changesCount: worktreeStatus.changesCount,
            hasUnpushed: worktreeStatus.hasUnpushed,
            branch,
            shortRev,
          }
        }
      }

      // Detect symlink drift: symlink target doesn't match expected ref from lock
      let symlinkDrift: SymlinkDrift | undefined = undefined
      if (memberExists && !isLocal && lockedMember) {
        // Read symlink target
        const symlinkTarget = yield* fs
          .readLink(memberPath.replace(/\/$/, ''))
          .pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (symlinkTarget !== null) {
          // Extract ref from symlink path using shared utility
          const extracted = extractRefFromSymlinkPath(symlinkTarget)

          // Compare with expected ref from lock file
          if (extracted !== undefined && extracted.ref !== lockedMember.ref) {
            symlinkDrift = {
              symlinkRef: extracted.ref,
              expectedRef: lockedMember.ref,
              actualGitBranch: currentBranch,
            }
          }
        }
      }

      // Detect commit drift: local worktree commit differs from locked commit
      let commitDrift: CommitDrift | undefined = undefined
      if (memberExists && !isLocal && lockedMember && fullCommit) {
        if (fullCommit !== lockedMember.commit) {
          commitDrift = {
            localCommit: fullCommit,
            lockedCommit: lockedMember.commit,
          }
        }
      }

      members.push({
        name: memberName,
        exists: memberExists,
        symlinkExists,
        source: sourceString,
        isLocal,
        lockInfo: lockedMember
          ? {
              ref: lockedMember.ref,
              commit: lockedMember.commit,
              pinned: lockedMember.pinned,
            }
          : undefined,
        isMegarepo,
        nestedMembers,
        gitStatus,
        symlinkDrift,
        commitDrift,
      })
    }

    return members
  })

/** Show megarepo status */
export const statusCommand = Cli.Command.make(
  'status',
  {
    output: outputOption,
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively show status of nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const fs = yield* FileSystem.FileSystem
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
      }

      const name = yield* Git.deriveMegarepoName(root.value)

      // Load config
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Scan members (recursively if --all)
      const members = yield* scanMembersRecursive({
        megarepoRoot: root.value,
        all,
      })

      // Get last sync time and lock staleness from lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lastSyncTime: Date | undefined = undefined
      let lockStaleness:
        | {
            exists: boolean
            missingFromLock: readonly string[]
            extraInLock: readonly string[]
          }
        | undefined = undefined

      // Determine which members are remote (need lock tracking)
      const remoteMemberNames = new Set<string>()
      for (const [memberName, sourceString] of Object.entries(config.members)) {
        const source = parseSourceString(sourceString)
        if (source !== undefined && isRemoteSource(source)) {
          remoteMemberNames.add(memberName)
        }
      }

      if (Option.isSome(lockFileOpt)) {
        // Find the most recent lockedAt timestamp across all members
        const timestamps = Object.values(lockFileOpt.value.members)
          .map((m) => new Date(m.lockedAt).getTime())
          .filter((t) => !Number.isNaN(t))
        if (timestamps.length > 0) {
          lastSyncTime = new Date(Math.max(...timestamps))
        }

        // Check staleness
        const staleness = checkLockStaleness({
          lockFile: lockFileOpt.value,
          configMemberNames: remoteMemberNames,
        })
        lockStaleness = {
          exists: true,
          missingFromLock: staleness.addedMembers,
          extraInLock: staleness.removedMembers,
        }
      } else if (remoteMemberNames.size > 0) {
        // Lock file doesn't exist but we have remote members
        lockStaleness = {
          exists: false,
          missingFromLock: [...remoteMemberNames],
          extraInLock: [],
        }
      }

      // Compute current member path (for highlighting current location)
      const cwdNormalized = cwd.replace(/\/$/, '')
      const rootNormalized = root.value.replace(/\/$/, '')

      // First try path-based detection (handles repos/<member>/repos/<member>/... paths)
      let currentMemberPath: string[] | undefined = undefined
      if (cwdNormalized !== rootNormalized && cwdNormalized.startsWith(rootNormalized)) {
        const relativePath = cwdNormalized.slice(rootNormalized.length + 1)
        const parts = relativePath.split('/')
        const memberPath: string[] = []
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === MEMBER_ROOT_DIR && i + 1 < parts.length) {
            memberPath.push(parts[i + 1]!)
            i++ // Skip the member name we just added
          }
        }
        if (memberPath.length > 0) {
          currentMemberPath = memberPath
        }
      }

      // If path-based detection didn't work, try symlink resolution
      if (currentMemberPath === undefined) {
        const cwdRealPath = yield* fs.realPath(cwd).pipe(
          Effect.map((p) => p.replace(/\/$/, '')),
          Effect.catchAll(() => Effect.succeed(cwdNormalized)),
        )

        const findCurrentMemberPath = ({
          memberList,
          megarepoRoot,
          pathSoFar,
        }: {
          memberList: readonly MemberStatus[]
          megarepoRoot: string
          pathSoFar: string[]
        }): Effect.Effect<string[] | undefined, never, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            for (const member of memberList) {
              const memberSymlinkPath = getMemberPath({
                megarepoRoot: EffectPath.unsafe.absoluteDir(megarepoRoot),
                name: member.name,
              })
              const memberRealPath = yield* fs
                .realPath(memberSymlinkPath.replace(/\/$/, ''))
                .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

              if (memberRealPath !== undefined) {
                const memberRealPathNorm = memberRealPath.replace(/\/$/, '')
                if (
                  cwdRealPath === memberRealPathNorm ||
                  cwdRealPath.startsWith(memberRealPathNorm + '/')
                ) {
                  const newPath = [...pathSoFar, member.name]
                  if (cwdRealPath === memberRealPathNorm) {
                    return newPath
                  }
                  if (member.nestedMembers && member.nestedMembers.length > 0) {
                    const nestedResult = yield* findCurrentMemberPath({
                      memberList: member.nestedMembers,
                      megarepoRoot: memberRealPathNorm + '/',
                      pathSoFar: newPath,
                    })
                    if (nestedResult !== undefined) {
                      return nestedResult
                    }
                  }
                  return newPath
                }
              }
            }
            return undefined
          })

        currentMemberPath = yield* findCurrentMemberPath({
          memberList: members,
          megarepoRoot: root.value,
          pathSoFar: [],
        })
      }

      // When --all is false, truncate to top-level member only.
      // This ensures currentMemberPath always matches the flat member list.
      if (!all && currentMemberPath !== undefined && currentMemberPath.length > 1) {
        currentMemberPath = [currentMemberPath[0]!]
      }

      // Compute syncNeeded and syncReasons
      const syncReasons: string[] = []

      // Helper to collect sync reasons from members recursively
      const collectMemberSyncReasons = (memberList: readonly MemberStatus[], prefix = '') => {
        for (const member of memberList) {
          const memberLabel = prefix ? `${prefix}/${member.name}` : member.name
          if (!member.symlinkExists) {
            syncReasons.push(`Member '${memberLabel}' symlink missing`)
          } else if (!member.exists) {
            syncReasons.push(`Member '${memberLabel}' worktree missing`)
          }
          if (member.symlinkDrift) {
            syncReasons.push(
              `Member '${memberLabel}' symlink drift: ${member.symlinkDrift.symlinkRef} → ${member.symlinkDrift.expectedRef}`,
            )
          }
          if (member.nestedMembers) {
            collectMemberSyncReasons(member.nestedMembers, memberLabel)
          }
        }
      }
      collectMemberSyncReasons(members)

      // Check lock staleness
      if (lockStaleness) {
        if (!lockStaleness.exists) {
          syncReasons.push('Lock file missing')
        }
        for (const name of lockStaleness.missingFromLock) {
          syncReasons.push(`Member '${name}' not in lock file`)
        }
        for (const name of lockStaleness.extraInLock) {
          syncReasons.push(`Lock file has extra member '${name}'`)
        }
      }

      const syncNeeded = syncReasons.length > 0

      // Use StatusApp for all output modes (TTY, CI, JSON, NDJSON)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* StatusApp.run(
            React.createElement(StatusView, { stateAtom: StatusApp.stateAtom }),
          )

          tui.dispatch({
            _tag: 'SetState',
            state: {
              name,
              root: root.value,
              syncNeeded,
              syncReasons,
              members,
              all,
              lastSyncTime: lastSyncTime?.toISOString(),
              lockStaleness,
              currentMemberPath,
            },
          })
        }),
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/status')),
).pipe(Cli.Command.withDescription('Show workspace status and member states'))
