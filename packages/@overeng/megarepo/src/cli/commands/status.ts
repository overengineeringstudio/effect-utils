/**
 * Status Command
 *
 * Show workspace status and member states.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import {
  CONFIG_FILE_NAME,
  ConfigNotFoundError,
  getMemberPath,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
} from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { detectRefMismatch, type RefMismatch } from '../../lib/issues.ts'
import { checkLockStaleness, LOCK_FILE_NAME, readLockFile } from '../../lib/lock.ts'
import { extractRefFromSymlinkPath } from '../../lib/ref.ts'
import { type Store, StoreLayer } from '../../lib/store.ts'
import {
  Cwd,
  detectCurrentMemberPath,
  findMegarepoRoot,
  outputOption,
  outputModeLayer,
} from '../context.ts'
import { NotInMegarepoError } from '../errors.ts'
import { StatusApp, StatusView } from '../renderers/StatusOutput/mod.ts'
import type {
  CommitDrift,
  GitStatus,
  MemberStatus,
  StaleLock,
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
  PlatformError.PlatformError | ParseResult.ParseError | Error,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Store
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Prevent cycles
    const normalizedRoot = megarepoRoot.replace(/\/$/, '')
    if (visited.has(normalizedRoot) === true) {
      return []
    }
    visited.add(normalizedRoot)

    // Load config
    const configResult = yield* readMegarepoConfig(megarepoRoot).pipe(
      Effect.catchIf(
        (e): e is ConfigNotFoundError => e instanceof ConfigNotFoundError,
        () => Effect.succeed(undefined),
      ),
    )
    if (configResult === undefined) {
      return []
    }
    const { config } = configResult

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
      if (symlinkExists === true && isLocal === false) {
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
      const isMegarepo =
        memberExists === true
          ? yield* fs.exists(nestedConfigPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
          : false

      // Recursively scan nested members if this is a megarepo and --all is used
      let nestedMembers: readonly MemberStatus[] | undefined = undefined
      if (all === true && isMegarepo === true && memberExists === true) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') === true ? memberPath : `${memberPath}/`,
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
      if (memberExists === true) {
        // Check if it's a git repo first
        const isGit = yield* Git.isGitRepo(memberPath)
        if (isGit === true) {
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
          const fullCommitOpt = yield* Git.getCurrentCommit(memberPath).pipe(Effect.option)
          fullCommit = Option.getOrUndefined(fullCommitOpt)
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

      // Read symlink target for drift detection
      const symlinkTarget =
        memberExists === true && isLocal === false
          ? yield* fs
              .readLink(memberPath.replace(/\/$/, ''))
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
          : null

      // Get source ref (what megarepo.json intends)
      const sourceRef =
        source !== undefined && source.type !== 'path'
          ? Option.getOrElse(source.ref, () => 'main')
          : undefined

      // Detect stale lock vs symlink drift
      // These are mutually exclusive scenarios:
      //
      // Stale lock: lock.ref ≠ symlink.ref, but symlink.ref === source.ref
      //   - Current state matches intent, lock is just outdated
      //   - Fix: mr lock (updates lock)
      //
      // Symlink drift: lock.ref === symlink.ref, but lock.ref ≠ source.ref
      //   - Lock and symlink are in sync, but don't match config intent
      //   - Fix: mr fetch --apply (switch to source ref) or edit megarepo.json
      let staleLock: StaleLock | undefined = undefined
      let symlinkDrift: SymlinkDrift | undefined = undefined

      if (symlinkTarget !== null && lockedMember !== undefined && sourceRef !== undefined) {
        const extracted = extractRefFromSymlinkPath(symlinkTarget)
        const symlinkRef = extracted?.ref

        if (symlinkRef !== undefined && lockedMember.ref !== sourceRef) {
          if (symlinkRef === sourceRef && symlinkRef !== lockedMember.ref) {
            // Stale lock: symlink matches source, lock is outdated
            staleLock = {
              lockRef: lockedMember.ref,
              actualRef: symlinkRef,
            }
          } else if (symlinkRef === lockedMember.ref && symlinkRef !== sourceRef) {
            // True symlink drift: symlink follows lock, but lock doesn't match source
            symlinkDrift = {
              symlinkRef,
              sourceRef,
              actualGitBranch: currentBranch,
            }
          }
        }
      }

      // Detect commit drift: local worktree commit differs from locked commit
      let commitDrift: CommitDrift | undefined = undefined
      if (
        memberExists === true &&
        isLocal === false &&
        lockedMember !== undefined &&
        fullCommit !== undefined
      ) {
        if (fullCommit !== lockedMember.commit) {
          commitDrift = {
            localCommit: fullCommit,
            lockedCommit: lockedMember.commit,
          }
        }
      }

      // Detect ref mismatch: worktree git HEAD differs from store path ref (Issue #88)
      // This happens when user runs `git checkout <branch>` directly in the worktree
      let refMismatch: RefMismatch | undefined = undefined
      if (symlinkTarget !== null) {
        refMismatch =
          (yield* detectRefMismatch({
            worktreePath: memberPath as AbsoluteDirPath,
            symlinkTarget,
          })) ?? undefined
      }

      members.push({
        name: memberName,
        exists: memberExists,
        symlinkExists,
        source: sourceString,
        isLocal,
        lockInfo:
          lockedMember !== undefined
            ? {
                ref: lockedMember.ref,
                commit: lockedMember.commit,
                pinned: lockedMember.pinned,
              }
            : undefined,
        isMegarepo,
        nestedMembers,
        gitStatus,
        staleLock,
        symlinkDrift,
        commitDrift,
        refMismatch,
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

      if (Option.isNone(root) === true) {
        return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
      }

      const workspaceName = yield* Git.deriveMegarepoName(root.value)

      // Load config
      const { config } = yield* readMegarepoConfig(root.value)

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
        if (source !== undefined && isRemoteSource(source) === true) {
          remoteMemberNames.add(memberName)
        }
      }

      if (Option.isSome(lockFileOpt) === true) {
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

      // Compute current member path (for scope dimming)
      let currentMemberPath = detectCurrentMemberPath({ cwd, megarepoRoot: root.value, all })

      // If path-based detection didn't work, try symlink resolution
      if (currentMemberPath === undefined) {
        const cwdRealPath = yield* fs.realPath(cwd).pipe(
          Effect.map((p) => p.replace(/\/$/, '')),
          Effect.catchAll(() => Effect.succeed(cwd.replace(/\/$/, ''))),
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
                .pipe(Effect.catchAll(() => Effect.void))

              if (memberRealPath !== undefined) {
                const memberRealPathNorm = memberRealPath.replace(/\/$/, '')
                if (
                  cwdRealPath === memberRealPathNorm ||
                  cwdRealPath.startsWith(memberRealPathNorm + '/') === true
                ) {
                  const newPath = [...pathSoFar, member.name]
                  if (cwdRealPath === memberRealPathNorm) {
                    return newPath
                  }
                  if (member.nestedMembers !== undefined && member.nestedMembers.length > 0) {
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

      // Compute workspace vs lock reconciliation needs.
      const workspaceSyncReasons: string[] = []
      const lockSyncReasons: string[] = []

      // Helper to collect sync reasons from members recursively
      const collectMemberSyncReasons = ({
        memberList,
        prefix = '',
      }: {
        memberList: readonly MemberStatus[]
        prefix?: string
      }) => {
        for (const member of memberList) {
          const memberLabel =
            prefix !== undefined && prefix !== '' ? `${prefix}/${member.name}` : member.name
          if (member.symlinkExists === false) {
            workspaceSyncReasons.push(`Member '${memberLabel}' symlink missing`)
          } else if (member.exists === false) {
            workspaceSyncReasons.push(`Member '${memberLabel}' worktree missing`)
          }
          if (member.staleLock !== undefined) {
            lockSyncReasons.push(
              `Member '${memberLabel}' stale lock: lock says '${member.staleLock.lockRef}' but actual is '${member.staleLock.actualRef}'`,
            )
          }
          if (member.symlinkDrift !== undefined) {
            workspaceSyncReasons.push(
              `Member '${memberLabel}' symlink drift: tracking '${member.symlinkDrift.symlinkRef}' but source says '${member.symlinkDrift.sourceRef}'`,
            )
          }
          if (member.refMismatch !== undefined) {
            workspaceSyncReasons.push(
              `Member '${memberLabel}' ref mismatch: store path expects '${member.refMismatch.expectedRef}' but git HEAD is '${member.refMismatch.actualRef}'`,
            )
          }
          if (member.commitDrift !== undefined) {
            lockSyncReasons.push(
              `Member '${memberLabel}' commit drift: workspace is '${member.commitDrift.localCommit.slice(0, 8)}' but lock records '${member.commitDrift.lockedCommit.slice(0, 8)}'`,
            )
          }
          if (member.nestedMembers !== undefined) {
            collectMemberSyncReasons({ memberList: member.nestedMembers, prefix: memberLabel })
          }
        }
      }
      collectMemberSyncReasons({ memberList: members })

      // Check lock staleness
      if (lockStaleness !== undefined) {
        if (lockStaleness.exists === false) {
          lockSyncReasons.push('Lock file missing')
        }
        for (const memberName of lockStaleness.missingFromLock) {
          lockSyncReasons.push(`Member '${memberName}' not in lock file`)
        }
        for (const memberName of lockStaleness.extraInLock) {
          lockSyncReasons.push(`Lock file has extra member '${memberName}'`)
        }
      }

      const syncReasons = [...workspaceSyncReasons, ...lockSyncReasons]
      const workspaceSyncNeeded = workspaceSyncReasons.length > 0
      const lockSyncNeeded = lockSyncReasons.length > 0
      const syncNeeded = syncReasons.length > 0

      // Use StatusApp for all output modes (TTY, CI, JSON, NDJSON)
      yield* run(
        StatusApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetState',
              state: {
                name: workspaceName,
                root: root.value,
                syncNeeded,
                workspaceSyncNeeded,
                lockSyncNeeded,
                syncReasons,
                members,
                all,
                lastSyncTime: lastSyncTime?.toISOString(),
                lockStaleness,
                currentMemberPath,
              },
            })
          }),
        { view: React.createElement(StatusView, { stateAtom: StatusApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/status')),
).pipe(Cli.Command.withDescription('Show workspace status and member states'))
