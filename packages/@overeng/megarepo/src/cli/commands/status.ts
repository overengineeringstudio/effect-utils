/**
 * Status Command
 *
 * Show workspace status and member states.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Console, Effect, Option, type ParseResult, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { jsonError, withJsonMode } from '@overeng/utils/node'

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
import { outputLines, renderStatus, type GitStatus, type MemberStatus } from '../renderers/mod.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

/**
 * Recursively scan members and build status tree.
 * @param megarepoRoot - Root path of the megarepo
 * @param visited - Set of visited paths to prevent cycles
 */
const scanMembersRecursive = ({
  megarepoRoot,
  visited = new Set<string>(),
}: {
  megarepoRoot: AbsoluteDirPath
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
      const memberExists = yield* fs.exists(memberPath)
      const source = parseSourceString(sourceString)
      const isLocal = source?.type === 'path'
      const lockedMember = lockFile?.members[memberName]

      // Check if this member is itself a megarepo
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const isMegarepo = memberExists
        ? yield* fs.exists(nestedConfigPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
        : false

      // Recursively scan nested members if this is a megarepo
      let nestedMembers: readonly MemberStatus[] | undefined = undefined
      if (isMegarepo && memberExists) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') ? memberPath : `${memberPath}/`,
        )
        nestedMembers = yield* scanMembersRecursive({ megarepoRoot: nestedRoot, visited })
      }

      // Get git status if member exists
      let gitStatus: GitStatus | undefined = undefined
      if (memberExists) {
        // Check if it's a git repo first
        const isGit = yield* Git.isGitRepo(memberPath).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (isGit) {
          // Get worktree status (dirty, unpushed)
          const worktreeStatus = yield* Git.getWorktreeStatus(memberPath).pipe(
            Effect.catchAll(() =>
              Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 }),
            ),
          )

          // Get current branch
          const branchOpt = yield* Git.getCurrentBranch(memberPath).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          const branch = Option.getOrElse(branchOpt, () => 'HEAD')

          // Get short rev
          const shortRev = yield* Git.getCurrentCommit(memberPath).pipe(
            Effect.map((commit) => commit.slice(0, 7)),
            Effect.catchAll(() => Effect.succeed(undefined)),
          )

          gitStatus = {
            isDirty: worktreeStatus.isDirty,
            changesCount: worktreeStatus.changesCount,
            hasUnpushed: worktreeStatus.hasUnpushed,
            branch,
            shortRev,
          }
        }
      }

      members.push({
        name: memberName,
        exists: memberExists,
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
      })
    }

    return members
  })

/** Show megarepo status */
export const statusCommand = Cli.Command.make('status', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const fs = yield* FileSystem.FileSystem
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
      }
      yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      // Load config for JSON output
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      console.log(
        JSON.stringify({
          name,
          root: root.value,
          memberCount: Object.keys(config.members).length,
          members: Object.keys(config.members),
        }),
      )
    } else {
      // Load config for staleness check
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Recursively scan all members
      const members = yield* scanMembersRecursive({ megarepoRoot: root.value })

      // Get last sync time and lock staleness from lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lastSyncTime: Date | undefined = undefined
      let lockStaleness: {
        exists: boolean
        missingFromLock: readonly string[]
        extraInLock: readonly string[]
      } | undefined = undefined

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
      // We need to handle two cases:
      // 1. User is in repos/<member> path - use path-based detection
      // 2. User is in a convenience symlink - resolve and match against member targets
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
      // This handles convenience symlinks outside repos/ directory
      if (currentMemberPath === undefined) {
        const cwdRealPath = yield* fs.realPath(cwd).pipe(
          Effect.map((p) => p.replace(/\/$/, '')),
          Effect.catchAll(() => Effect.succeed(cwdNormalized)),
        )

        // Find which member (if any) the cwd is inside by matching against member symlink targets
        const findCurrentMemberPath = (
          memberList: readonly MemberStatus[],
          megarepoRoot: string,
          pathSoFar: string[],
        ): Effect.Effect<string[] | undefined, never, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            for (const member of memberList) {
              const memberSymlinkPath = getMemberPath({
                megarepoRoot: EffectPath.unsafe.absoluteDir(megarepoRoot),
                name: member.name,
              })
              const memberRealPath = yield* fs.realPath(memberSymlinkPath.replace(/\/$/, '')).pipe(
                Effect.catchAll(() => Effect.succeed(undefined)),
              )

              if (memberRealPath !== undefined) {
                const memberRealPathNorm = memberRealPath.replace(/\/$/, '')
                // Check if cwd resolves to this member or inside it
                if (
                  cwdRealPath === memberRealPathNorm ||
                  cwdRealPath.startsWith(memberRealPathNorm + '/')
                ) {
                  const newPath = [...pathSoFar, member.name]
                  // If exact match, we found it
                  if (cwdRealPath === memberRealPathNorm) {
                    return newPath
                  }
                  // If inside, check nested members
                  if (member.nestedMembers && member.nestedMembers.length > 0) {
                    const nestedResult = yield* findCurrentMemberPath(
                      member.nestedMembers,
                      memberRealPathNorm + '/',
                      newPath,
                    )
                    if (nestedResult !== undefined) {
                      return nestedResult
                    }
                  }
                  // Inside this member but not in a nested megarepo
                  return newPath
                }
              }
            }
            return undefined
          })

        currentMemberPath = yield* findCurrentMemberPath(members, root.value, [])
      }

      // Render and output
      const lines = renderStatus({
        name,
        root: root.value,
        members,
        lastSyncTime,
        lockStaleness,
        currentMemberPath,
      })
      yield* outputLines(lines)
    }
  }).pipe(Effect.withSpan('megarepo/status'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Show workspace status and member states'))
