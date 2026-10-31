/**
 * Member Sync
 *
 * Sync a single member using the bare repo + worktree pattern.
 */

import { lstat, rmdir } from 'node:fs/promises'
import path from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  getMemberPath,
  getSourceRef,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../core/config.ts'
import * as Git from '../core/git.ts'
import { detectRefMismatch, formatRefMismatchMessage } from '../core/issues.ts'
import type { LockFile } from '../core/lock.ts'
import * as Observability from '../core/observability.ts'
import { classifyRef, extractRefFromSymlinkPath, isCommitSha, type RefType } from '../core/ref.ts'
import {
  canonicalizeStorePath,
  resolveStoreBranchWorktree,
} from '../store/store-branch-worktree.ts'
import { createStoreWorktree, createStoreWorktreeDetached } from '../store/store-deletion-lease.ts'
import { StoreLock } from '../store/store-lock.ts'
import { assertCanonicalMutationAllowed, makeStoreDirectory } from '../store/store-path.ts'
import { Store } from '../store/store.ts'
import { foreignMemberMountMessage, inspectMemberMount } from './member-mount.ts'
import type { MemberSyncResult, SyncMode } from './types.ts'

/**
 * Action to take when a ref doesn't exist
 */
export type MissingRefAction = 'create' | 'skip' | 'abort' | 'error'

/**
 * Information about a missing ref, passed to the onMissingRef callback
 */
export interface MissingRefInfo {
  readonly memberName: string
  readonly ref: string
  readonly defaultBranch: string
  readonly cloneUrl: string
}

/**
 * Get the git clone URL for a member source (SSH format)
 */
export const getCloneUrl = (source: MemberSource): string | undefined => {
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
 * Get the git clone URL for a member source (HTTPS format)
 */
export const getCloneUrlHttps = (source: MemberSource): string | undefined => {
  switch (source.type) {
    case 'github':
      return `https://github.com/${source.owner}/${source.repo}.git`
    case 'url':
      return source.url
    case 'path':
      return undefined
  }
}

/**
 * Git protocol selection for cloning
 * - 'ssh': Always use SSH URLs (git@github.com:...)
 * - 'https': Always use HTTPS URLs (https://github.com/...)
 * - 'auto': Use lock file URL if available, otherwise SSH (default)
 */
export type GitProtocol = 'ssh' | 'https' | 'auto'

/**
 * Resolve the clone URL based on git protocol preference.
 * In 'auto' mode, uses the lock file URL if available (which is typically HTTPS),
 * otherwise falls back to SSH.
 */
export const resolveCloneUrl = ({
  source,
  gitProtocol,
  lockFileUrl,
}: {
  source: MemberSource
  gitProtocol: GitProtocol
  lockFileUrl: string | undefined
}): string | undefined => {
  switch (gitProtocol) {
    case 'ssh':
      return getCloneUrl(source)
    case 'https':
      return getCloneUrlHttps(source)
    case 'auto':
      // Prefer lock file URL if available (typically HTTPS from lock file)
      // Otherwise fall back to SSH (original behavior)
      return lockFileUrl ?? getCloneUrl(source)
  }
}

/**
 * Create a symlink, stripping trailing slashes from paths.
 * POSIX symlink fails with ENOENT if the link path ends with `/`.
 */
const createSymlink = ({ target, link }: { target: string; link: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.symlink(target.replace(/\/$/, ''), link.replace(/\/$/, ''))
  })

/** Fail-closed refusal to remove an unproven commit-worktree remnant. */
export class CommitWorktreeRemnantConflict extends Schema.TaggedError<CommitWorktreeRemnantConflict>()(
  'CommitWorktreeRemnantConflict',
  {
    reason: Schema.Literals([
      'Registered',
      'NonEmpty',
      'NotDirectory',
      'SymbolicLink',
      'Ambiguous',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const commitWorktreeRemnantConflict = ({
  path: conflictPath,
  reason,
  message,
  cause,
}: {
  path: string
  reason: CommitWorktreeRemnantConflict['reason']
  message: string
  cause?: unknown
}) =>
  new CommitWorktreeRemnantConflict({
    path: conflictPath,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * Remove only a proven-empty commit target that no current Git worktree registration names.
 *
 * Registration paths and the target are compared after resolving symlinks so an alias cannot
 * hide a live registration. `rmdir` is the final empty-directory oracle, so an entry introduced
 * after inspection is preserved rather than recursively deleted.
 */
const removeEmptyUnregisteredCommitWorktreeRemnant = ({
  bareRepoPath,
  worktreePath,
}: {
  bareRepoPath: string
  worktreePath: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const target = worktreePath.replace(/\/+$/u, '')
    const targetStat = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await lstat(target)
        } catch (cause) {
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'ENOENT'
          )
            return undefined
          throw cause
        }
      },
      catch: (cause) =>
        commitWorktreeRemnantConflict({
          path: target,
          reason: 'Ambiguous',
          message: `Cannot inspect commit worktree target '${target}'`,
          cause,
        }),
    })
    if (targetStat === undefined) return
    if (targetStat.isSymbolicLink() === true) {
      return yield* commitWorktreeRemnantConflict({
        path: target,
        reason: 'SymbolicLink',
        message: `Refusing to remove commit worktree target '${target}': it is a symbolic link`,
      })
    }
    if (targetStat.isDirectory() === false) {
      return yield* commitWorktreeRemnantConflict({
        path: target,
        reason: 'NotDirectory',
        message: `Refusing to remove commit worktree target '${target}': it is not a directory`,
      })
    }

    const physicalTarget = yield* fs.realPath(target).pipe(
      Effect.mapError((cause) =>
        commitWorktreeRemnantConflict({
          path: target,
          reason: 'Ambiguous',
          message: `Cannot resolve physical identity of commit worktree target '${target}'`,
          cause,
        }),
      ),
    )
    const registrations = yield* Git.listWorktrees(bareRepoPath).pipe(
      Effect.mapError((cause) =>
        commitWorktreeRemnantConflict({
          path: target,
          reason: 'Ambiguous',
          message: `Cannot inspect Git registrations before removing commit worktree target '${target}'`,
          cause,
        }),
      ),
    )
    for (const registration of registrations) {
      const physicalRegistration = yield* fs.realPath(registration.path).pipe(
        Effect.mapError((cause) =>
          commitWorktreeRemnantConflict({
            path: target,
            reason: 'Ambiguous',
            message: `Cannot resolve physical identity of Git worktree registration '${registration.path}'`,
            cause,
          }),
        ),
      )
      if (physicalRegistration === physicalTarget) {
        return yield* commitWorktreeRemnantConflict({
          path: target,
          reason: 'Registered',
          message: `Refusing to remove commit worktree target '${target}': Git registration '${registration.path}' identifies the same physical directory`,
        })
      }
    }

    const removalStat = yield* Effect.tryPromise({
      try: () => lstat(target),
      catch: (cause) =>
        commitWorktreeRemnantConflict({
          path: target,
          reason: 'Ambiguous',
          message: `Cannot recheck commit worktree target '${target}' before removal`,
          cause,
        }),
    })
    if (
      removalStat.isDirectory() === false ||
      removalStat.isSymbolicLink() === true ||
      removalStat.dev !== targetStat.dev ||
      removalStat.ino !== targetStat.ino
    ) {
      return yield* commitWorktreeRemnantConflict({
        path: target,
        reason: 'Ambiguous',
        message: `Refusing to remove commit worktree target '${target}': its physical identity changed during inspection`,
      })
    }

    yield* Effect.tryPromise({
      try: () => rmdir(target),
      catch: (cause) => {
        const code =
          cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
            ? cause.code
            : undefined
        return commitWorktreeRemnantConflict({
          path: target,
          reason:
            code === 'ENOTEMPTY' || code === 'EEXIST'
              ? 'NonEmpty'
              : code === 'ENOTDIR'
                ? 'NotDirectory'
                : 'Ambiguous',
          message:
            code === 'ENOTEMPTY' || code === 'EEXIST'
              ? `Refusing to remove commit worktree target '${target}': the directory is not empty`
              : code === 'ENOTDIR'
                ? `Refusing to remove commit worktree target '${target}': it is not a directory`
                : `Cannot atomically remove empty commit worktree target '${target}'`,
          cause,
        })
      },
    })
  })

/**
 * A pinned materialization that disagrees with the lock entry that produced it.
 *
 * Both sides are already display-formatted: commit worktrees are identified by sha and are
 * abbreviated, tag worktrees by tag name and are shown whole.
 */
type PinnedDrift = { materialized: string; locked: string }

/**
 * Whether a materialized worktree contradicts the lock entry that produced it.
 *
 * Commit (`refs/commits/<sha>`) and tag (`refs/tags/<tag>`) worktrees are pinned: apply put
 * them there to satisfy an exact lock entry, and nothing else legitimately moves them. Branch
 * worktrees are excluded — co-development moves `HEAD` ahead of the lock on purpose.
 *
 * The two pinned kinds compare on different fields, because a commit worktree is named by sha
 * and a tag worktree by tag name. Comparing a tag against `lockedMember.commit` would report
 * drift for every correctly-materialized tag.
 */
export const computePinnedDrift = ({
  symlinkRef,
  lockedMember,
}: {
  symlinkRef: { ref: string; type: 'branch' | 'tag' | 'commit' } | undefined
  lockedMember: { ref: string; commit: string } | undefined
}): PinnedDrift | undefined => {
  if (symlinkRef === undefined || lockedMember === undefined) return undefined

  switch (symlinkRef.type) {
    case 'commit':
      return symlinkRef.ref !== lockedMember.commit
        ? { materialized: symlinkRef.ref.slice(0, 8), locked: lockedMember.commit.slice(0, 8) }
        : undefined
    case 'tag':
      return symlinkRef.ref !== lockedMember.ref
        ? { materialized: symlinkRef.ref, locked: lockedMember.ref }
        : undefined
    case 'branch':
      return undefined
  }
}

/**
 * Apply promises Lock → Workspace. When it cannot deliver that for a member, reporting
 * `skipped` exits 0 and leaves the workspace silently disagreeing with the lock — the
 * failure mode behind #962. Report the drift instead so the exit code is honest.
 */
const applyDriftError = ({
  name,
  reason,
  drift,
}: {
  name: string
  reason: string
  drift: PinnedDrift
}): MemberSyncResult => ({
  name,
  status: 'error',
  message:
    `${reason}\n` +
    `  workspace is at ${drift.materialized} but megarepo.lock records ${drift.locked}\n` +
    `  hint: commit or discard the changes in the worktree, then re-run 'mr apply' (or use --force to discard them)`,
})

/**
 * Sync a single member: use bare repo + worktree pattern
 *
 * Modes (see cli-redesign-spec.md):
 * - fetch: Remote → Lock. Clone/fetch, resolve commits. Never touches workspace.
 * - apply: Lock → Workspace. Create worktrees from lock, symlink. Never writes lock.
 * - lock:  Workspace → Lock. Record current HEAD commits. No network, no workspace changes.
 */
export const syncMember = <R = never>({
  name,
  sourceString,
  megarepoRoot,
  lockFile,
  mode,
  dryRun,
  force,
  gitProtocol = 'auto',
  createBranches = false,
  commitMode,
  onMissingRef,
  onWorktreeCreated,
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  mode: SyncMode
  dryRun: boolean
  force: boolean
  /** Git protocol to use for cloning: 'ssh', 'https', or 'auto' (default) */
  gitProtocol?: GitProtocol
  /** Create branches that don't exist (from default branch) */
  createBranches?: boolean
  /** When true, use commit-based worktrees (refs/commits/<sha>) for deterministic apply */
  commitMode?: boolean
  /** Callback when a ref doesn't exist. If not provided, defaults to 'error' behavior. */
  onMissingRef?: (info: MissingRefInfo) => Effect.Effect<MissingRefAction, never, R>
  /** Reports only commit worktrees actually created under this invocation's worktree lock. */
  onWorktreeCreated?: (physicalRoot: string) => void
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store
    const storeLock = yield* StoreLock
    const isFetchMode = mode === 'fetch'
    const isApplyMode = mode === 'apply'
    const isLockMode = mode === 'lock'

    // Validate member name to prevent path traversal
    const nameError = validateMemberName(name)
    if (nameError !== undefined) {
      return {
        name,
        status: 'error',
        message: nameError,
      } satisfies MemberSyncResult
    }

    // Parse the source string
    const source = parseSourceString(sourceString)
    if (source === undefined) {
      return {
        name,
        status: 'error',
        message: `Invalid source string: ${sourceString}`,
      } satisfies MemberSyncResult
    }

    const memberPath = getMemberPath({ megarepoRoot, name })
    const memberPathNormalized = memberPath.replace(/\/$/, '')

    // Lock and apply must never interpret a foreign real path as an absent member mount.
    if (isFetchMode === false) {
      const memberMount = yield* inspectMemberMount(memberPathNormalized)
      if (memberMount._tag === 'Foreign') {
        return {
          name,
          status: 'error',
          message: foreignMemberMountMessage({
            name,
            path: memberPathNormalized,
            operation: 'replace',
          }),
        } satisfies MemberSyncResult
      }
    }

    // Fetch mode: skip local path members (nothing to fetch)
    if (source.type === 'path' && isFetchMode === true) {
      return { name, status: 'skipped', message: 'local path member' } satisfies MemberSyncResult
    }

    // Handle local path sources - just create symlink
    if (source.type === 'path') {
      const expandedPath = source.path.replace(/^~/, process.env.HOME ?? '~')
      const resolvedPath =
        path.isAbsolute(expandedPath) === true
          ? expandedPath
          : path.resolve(megarepoRoot, expandedPath)
      const existingLink = yield* fs
        .readLink(memberPathNormalized)
        .pipe(Effect.orElseSucceed(() => null))

      if (existingLink !== null) {
        if (existingLink.replace(/\/$/, '') === resolvedPath.replace(/\/$/, '')) {
          return { name, status: 'already_synced' } satisfies MemberSyncResult
        }
        // Path changed - check if old worktree has uncommitted changes before switching
        if (force === false && dryRun === false) {
          const worktreeStatus = yield* Git.getWorktreeStatus({ worktreePath: existingLink }).pipe(
            Effect.orElseSucceed(() => ({
              isDirty: false,
              hasUnpushed: false,
              changesCount: 0,
            })),
          )
          if (worktreeStatus.isDirty === true || worktreeStatus.hasUnpushed === true) {
            return {
              name,
              status: 'skipped',
              message:
                worktreeStatus.isDirty === true
                  ? `path changed but old worktree has ${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
                  : 'path changed but old worktree has unpushed commits (use --force to override)',
            } satisfies MemberSyncResult
          }
        }
        if (dryRun === false) {
          yield* fs.remove(memberPathNormalized)
        }
      } else {
        const exists = yield* fs
          .exists(memberPathNormalized)
          .pipe(Effect.orElseSucceed(() => false))
        if (exists === true) {
          return {
            name,
            status: 'error',
            message: foreignMemberMountMessage({
              name,
              path: memberPathNormalized,
              operation: 'replace',
            }),
          } satisfies MemberSyncResult
        }
      }

      if (dryRun === false) {
        yield* createSymlink({
          target: resolvedPath,
          link: memberPathNormalized,
        })
      }

      return { name, status: 'synced' } satisfies MemberSyncResult
    }

    // For remote sources, use bare repo + worktree pattern
    // Resolve clone URL based on git protocol preference
    const lockedMember = lockFile?.members[name]
    const cloneUrl = resolveCloneUrl({
      source,
      gitProtocol,
      lockFileUrl: lockedMember?.url,
    })
    if (cloneUrl === undefined) {
      return {
        name,
        status: 'error',
        message: 'Cannot get clone URL',
      } satisfies MemberSyncResult
    }

    const bareRepoPath = store.getBareRepoPath(source)
    const bareExists = yield* store.hasBareRepo(source)

    // Determine which ref to use
    let targetRef: string
    let targetCommit: string | undefined

    // Note: lockedMember was already retrieved above for resolveCloneUrl
    if (isApplyMode === true) {
      if (lockedMember === undefined) {
        return {
          name,
          status: 'error',
          message: 'Not in lock file (mr apply requires lock file)',
        } satisfies MemberSyncResult
      }
      targetRef = lockedMember.ref
      targetCommit = lockedMember.commit
    } else {
      // Use ref from source string, or determine default
      const sourceRef = getSourceRef(source)
      if (Option.isSome(sourceRef) === true) {
        targetRef = sourceRef.value
      } else {
        // Need to determine default branch
        if (bareExists === true) {
          const defaultBranch = yield* Git.getDefaultBranch({
            repoPath: bareRepoPath,
          })
          targetRef = Option.getOrElse(defaultBranch, () => 'main')
        } else {
          const defaultBranch = yield* Git.getDefaultBranch({ url: cloneUrl })
          targetRef = Option.getOrElse(defaultBranch, () => 'main')
        }
      }
    }

    const resolveWorktreePath = ({
      ref,
      refType,
    }: {
      readonly ref: string
      readonly refType: RefType
    }) => {
      const worktreePath = store.getWorktreePath({ source, ref, refType })
      return refType === 'branch' && bareExists === true
        ? resolveStoreBranchWorktree({ bareRepo: bareRepoPath, worktreePath, branch: ref })
        : Effect.succeed(worktreePath)
    }
    const worktreePathExists = (worktreePath: string) =>
      fs
        .exists(`${worktreePath}.git`.replace(/\/\.git$/u, '/.git'))
        .pipe(Effect.orElseSucceed(() => false))

    if (isFetchMode === true && lockedMember?.pinned === true && force === false) {
      return {
        name,
        status: 'skipped',
        message: `member is pinned at ${lockedMember.commit.slice(0, 8)} (use --force to update pinned members)`,
        commit: lockedMember.commit,
        ref: lockedMember.ref,
      } satisfies MemberSyncResult
    }

    // Check if member symlink already exists and points to a valid worktree
    const currentLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.orElseSucceed(() => null))
    const memberExists = currentLink !== null

    // Commit (`refs/commits/<sha>`) and tag (`refs/tags/<tag>`) worktrees are pinned
    // materializations: apply put them there to satisfy an exact lock entry, and nothing else
    // legitimately moves them. So if one disagrees with the lock, the workspace is wrong no
    // matter why apply could not fix it.
    //
    // Branch HEAD is not a pinned identity. Apply preserves the original branch
    // and selects a locked commit mount when it cannot reuse that branch exactly.
    //
    // The two are compared on different fields: a commit worktree is named by sha, a tag
    // worktree by tag name. Comparing a tag against `lockedMember.commit` would mismatch on
    // every correctly-materialized tag.
    const currentSymlinkRef =
      currentLink !== null ? extractRefFromSymlinkPath(currentLink.replace(/\/$/, '')) : undefined
    const pinnedDrift =
      isApplyMode === true
        ? computePinnedDrift({ symlinkRef: currentSymlinkRef, lockedMember })
        : undefined

    // Repointing a canonical branch mount preserves its worktree and local edits.
    // Other dirty mounts retain the explicit --force switching policy.
    const preservesCanonicalBranch =
      isApplyMode === true &&
      currentLink !== null &&
      currentSymlinkRef?.type === 'branch' &&
      currentLink.replace(/\/$/, '') ===
        (yield* resolveWorktreePath({
          ref: currentSymlinkRef.ref,
          refType: 'branch',
        })).replace(/\/$/, '')

    // In lock and apply modes, if member exists, check if symlink points to correct ref
    if (memberExists === true && (isLockMode === true || isApplyMode === true)) {
      const currentLinkNormalized = currentLink?.replace(/\/$/, '')

      if (isLockMode === true) {
        // Lock mode: check symlink against the expected branch worktree path
        const expectedWorktreePath = yield* resolveWorktreePath({
          ref: targetRef,
          refType: 'branch',
        })
        const expectedPathNormalized = expectedWorktreePath.replace(/\/$/, '')

        // Lock sync only records current branch-attached workspace state.
        if (currentLinkNormalized !== expectedPathNormalized) {
          const extracted =
            currentLinkNormalized !== undefined
              ? extractRefFromSymlinkPath(currentLinkNormalized)
              : undefined
          const symlinkRef = extracted?.ref

          return {
            name,
            status: 'skipped',
            message:
              `workspace is not synced to source ref '${targetRef}'` +
              ` (symlink points to '${symlinkRef ?? 'unknown'}')\n` +
              `  hint: run 'mr apply${name.length > 0 ? ` --only ${name}` : ''}' first`,
          } satisfies MemberSyncResult
        }

        // Read current HEAD from the worktree
        const currentCommitOpt = yield* Git.getCurrentCommit(memberPathNormalized).pipe(
          Effect.option,
        )
        const currentCommit = Option.getOrUndefined(currentCommitOpt)
        const currentBranchOpt = yield* Git.getCurrentBranch(memberPathNormalized).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        )
        const currentBranch = Option.getOrUndefined(currentBranchOpt)

        // Check for ref mismatch (invariant #8 violation)
        const refMismatch = yield* detectRefMismatch({
          worktreePath: memberPathNormalized,
          symlinkTarget: currentLinkNormalized,
        })

        if (refMismatch !== undefined) {
          return {
            name,
            status: 'skipped',
            message: formatRefMismatchMessage({ refMismatch, memberName: name }),
            refMismatch,
          } satisfies MemberSyncResult
        }

        const previousCommit = lockedMember?.commit
        const lockUpdated = currentCommit !== undefined && currentCommit !== previousCommit
        return {
          name,
          status: lockUpdated === true ? 'recorded' : 'already_synced',
          commit: currentCommit,
          previousCommit: lockUpdated === true ? previousCommit : undefined,
          ref: currentBranch ?? lockedMember?.ref ?? targetRef,
          lockUpdated,
        } satisfies MemberSyncResult
      }

      // Check if old worktree has uncommitted changes before switching
      if (preservesCanonicalBranch === false && force === false && dryRun === false) {
        const worktreeStatus = yield* Git.getWorktreeStatus({ worktreePath: currentLink }).pipe(
          Effect.orElseSucceed(() => ({
            isDirty: false,
            hasUnpushed: false,
            changesCount: 0,
          })),
        )
        if (worktreeStatus.isDirty === true || worktreeStatus.hasUnpushed === true) {
          const reason =
            worktreeStatus.isDirty === true
              ? `ref changed but old worktree has ${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
              : 'ref changed but old worktree has unpushed commits (use --force to override)'
          return pinnedDrift !== undefined
            ? applyDriftError({ name, reason, drift: pinnedDrift })
            : ({ name, status: 'skipped', message: reason } satisfies MemberSyncResult)
        }
      }
      // Fall through to content-aware worktree selection
    }

    if (isLockMode === true && memberExists === false) {
      return {
        name,
        status: 'skipped',
        message: `workspace member missing for '${targetRef}'\n  hint: run 'mr apply${name.length > 0 ? ` --only ${name}` : ''}' first`,
      } satisfies MemberSyncResult
    }

    // Clone bare repo if needed.
    const wasCloned: boolean = yield* Effect.gen(function* () {
      if (bareExists === false) {
        if (dryRun === false) {
          const repoBasePath = store.getRepoBasePath(source)
          yield* makeStoreDirectory(repoBasePath)
          const cloned = yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
          yield* Observability.annotateSyncMemberAction(
            cloned === true ? 'clone' : 'already-cloned-by-sibling',
          )
          return cloned
        }
        yield* Observability.annotateSyncMemberAction('skip-dry-run')
      } else if (isFetchMode === true && dryRun === false) {
        yield* Git.fetchBare({ repoPath: bareRepoPath, refs: [targetRef] }).pipe(Effect.ignore)
        yield* Observability.annotateSyncMemberAction('fetch')
      } else if (isApplyMode === true && targetCommit !== undefined && dryRun === false) {
        const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
        if (commitExists === false) {
          yield* Git.fetchBare({ repoPath: bareRepoPath, refs: [targetRef] }).pipe(Effect.ignore)
          yield* Observability.annotateSyncMemberAction('fetch-missing-commit')
        } else {
          yield* Observability.annotateSyncMemberAction('noop')
        }
      } else {
        yield* Observability.annotateSyncMemberAction('noop')
      }
      return false
    }).pipe(Observability.withSyncMemberCloneSpan({ name, bareExists }))

    /**
     * A lock entry can point at an object that disappeared after a force-push.
     * In lock update mode we can recover branch-based members by re-resolving `targetRef`,
     * but pinned commit-SHA refs remain hard failures because there is no mutable ref to follow.
     */
    if (dryRun === false && targetCommit !== undefined) {
      let commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })

      /**
       * Last-resort recovery before declaring the commit unreachable: the locked commit may live only
       * on a pull-request head, which the bare repo's `+refs/heads/*` refspec never fetches. Placed
       * here rather than next to the earlier fetch so it also covers a freshly cloned bare repo, and
       * it only costs a fetch when the commit is genuinely missing.
       */
      if (commitExists === false) {
        yield* Git.fetchPullRequestHeads({ repoPath: bareRepoPath }).pipe(Effect.ignore)
        yield* Observability.annotateSyncMemberAction('fetch-pull-request-heads')
        commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
      }

      if (commitExists === false) {
        const shortCommit = targetCommit.slice(0, 8)

        if (isApplyMode === true) {
          return {
            name,
            status: 'error',
            message: `locked commit '${shortCommit}' for ref '${targetRef}' is not available locally or on the remote`,
          } satisfies MemberSyncResult
        }

        if (isCommitSha(targetRef) === true) {
          return {
            name,
            status: 'error',
            message: `commit '${shortCommit}' is not available locally or on the remote`,
          } satisfies MemberSyncResult
        }

        targetCommit = undefined
      }
    }

    // Validate ref exists and resolve to commit
    const refResult = yield* Effect.gen(function* () {
      let needsCreateBranch = false
      let defaultBranchForCreate: string | undefined
      let resolvedRefType: RefType = classifyRef(targetRef)
      let resolvedCommit = targetCommit

      if (resolvedCommit === undefined && isCommitSha(targetRef) === false) {
        const refValidation = yield* Git.validateRefExists({
          ref: targetRef,
          bareRepoPath: bareExists === true ? bareRepoPath : undefined,
          bareExists,
          cloneUrl,
        })
        if (refValidation.exists === false) {
          if (bareExists === true) {
            const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
            defaultBranchForCreate = Option.getOrElse(defaultBranch, () => 'main')
          } else {
            const defaultBranch = yield* Git.getDefaultBranch({ url: cloneUrl })
            defaultBranchForCreate = Option.getOrElse(defaultBranch, () => 'main')
          }

          let action: MissingRefAction = 'error'

          if (createBranches === true) {
            action = 'create'
          } else if (onMissingRef !== undefined) {
            action = yield* onMissingRef({
              memberName: name,
              ref: targetRef,
              defaultBranch: defaultBranchForCreate,
              cloneUrl,
            })
          }

          switch (action) {
            case 'create':
              needsCreateBranch = true
              if (dryRun === true) {
                return {
                  _tag: 'early-return' as const,
                  result: {
                    name,
                    status: 'synced',
                    ref: targetRef,
                    message: `would create branch '${targetRef}' from '${defaultBranchForCreate}'`,
                  } satisfies MemberSyncResult,
                }
              }
              break
            case 'skip':
              return {
                _tag: 'early-return' as const,
                result: {
                  name,
                  status: 'skipped',
                  message: `branch '${targetRef}' does not exist`,
                } satisfies MemberSyncResult,
              }
            case 'abort':
              return {
                _tag: 'early-return' as const,
                result: {
                  name,
                  status: 'error',
                  message: `Sync aborted: branch '${targetRef}' does not exist`,
                } satisfies MemberSyncResult,
              }
            case 'error':
            default:
              return {
                _tag: 'early-return' as const,
                result: {
                  name,
                  status: 'error',
                  message: `Ref '${targetRef}' not found\n  hint: Check available refs with: git ls-remote --refs ${cloneUrl}\n  hint: Use --create-branches to create missing branches`,
                } satisfies MemberSyncResult,
              }
          }
        }
      }

      // Create branch if needed
      if (needsCreateBranch === true && defaultBranchForCreate !== undefined && dryRun === false) {
        yield* Git.createAndPushBranch({
          repoPath: bareRepoPath,
          branch: targetRef,
          baseRef: defaultBranchForCreate,
        })
      }

      // Resolve ref to commit if not already known
      if (resolvedCommit === undefined && dryRun === false) {
        if (isCommitSha(targetRef) === true) {
          resolvedCommit = targetRef
          resolvedRefType = 'commit'
        } else {
          const refInfo = yield* Git.queryLocalRefType({
            repoPath: bareRepoPath,
            ref: targetRef,
          })

          if (refInfo.type === 'tag') {
            resolvedRefType = 'tag'
            resolvedCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/tags/${targetRef}`,
            }).pipe(Effect.catch(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
          } else if (refInfo.type === 'branch') {
            resolvedRefType = 'branch'
            resolvedCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/remotes/origin/${targetRef}`,
            }).pipe(Effect.catch(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
          } else {
            const heuristicType = classifyRef(targetRef)
            resolvedRefType = heuristicType
            if (heuristicType === 'tag') {
              resolvedCommit = yield* Git.resolveRef({
                repoPath: bareRepoPath,
                ref: `refs/tags/${targetRef}`,
              }).pipe(
                Effect.catch(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
              )
            } else {
              resolvedCommit = yield* Git.resolveRef({
                repoPath: bareRepoPath,
                ref: `refs/remotes/origin/${targetRef}`,
              }).pipe(
                Effect.catch(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
              )
            }
          }
        }
      }

      return {
        _tag: 'resolved' as const,
        commit: resolvedCommit,
        refType: resolvedRefType,
        needsCreateBranch,
        defaultBranchForCreate,
      }
    }).pipe(Observability.withSyncMemberResolveRefSpan(targetRef))

    if (refResult._tag === 'early-return') return refResult.result
    // In apply mode, use the locked commit — not the bare repo's current branch tip.
    // The resolution is still needed for refType classification and ref validation.
    targetCommit =
      isApplyMode === true && lockedMember?.commit !== undefined
        ? lockedMember.commit
        : refResult.commit
    const actualRefType = refResult.refType

    // Fetch mode: resolved commit is all we need. Don't touch workspace.
    if (isFetchMode === true) {
      const previousCommit = lockedMember?.commit
      const isUpdate = previousCommit !== undefined && previousCommit !== targetCommit
      return {
        name,
        status: isUpdate === true ? 'updated' : 'already_synced',
        commit: targetCommit,
        previousCommit: isUpdate === true ? previousCommit : undefined,
        ref: targetRef,
      } satisfies MemberSyncResult
    }
    const needsCreateBranch = refResult.needsCreateBranch
    const defaultBranchForCreate = refResult.defaultBranchForCreate

    /** Re-check immutable source refs before worktree creation. */
    if (dryRun === false && targetCommit !== undefined && isCommitSha(targetRef) === true) {
      const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
      if (commitExists === false) {
        return {
          name,
          status: 'error',
          message: `commit '${targetCommit.slice(0, 8)}' is not available locally or on the remote`,
        } satisfies MemberSyncResult
      }
    }

    // Tracking is a read-only choice: reuse a clean branch only at the exact lock.
    // Otherwise select the immutable commit worktree before materialization.
    type WorktreeSelection =
      | { readonly _tag: 'branch'; readonly ref: string }
      | { readonly _tag: 'commit'; readonly commit: string }
      | { readonly _tag: 'default'; readonly ref: string; readonly refType: RefType }
    const worktreeSelection: WorktreeSelection = yield* Effect.gen(function* () {
      if (isApplyMode === false || targetCommit === undefined) {
        return { _tag: 'default' as const, ref: targetRef, refType: actualRefType }
      }
      if (commitMode === true && (actualRefType === 'branch' || actualRefType === 'tag')) {
        return { _tag: 'commit' as const, commit: targetCommit }
      }
      if (actualRefType !== 'branch') {
        return { _tag: 'default' as const, ref: targetRef, refType: actualRefType }
      }
      const branchPath = yield* resolveWorktreePath({ ref: targetRef, refType: 'branch' })
      if ((yield* worktreePathExists(branchPath)) === true) {
        const reusable = yield* Effect.gen(function* () {
          if ((yield* Git.getCurrentCommit(branchPath)) !== targetCommit) return false
          const branch = yield* Git.getCurrentBranch(branchPath)
          if (Option.isNone(branch) === true || branch.value !== targetRef) return false
          return (yield* Git.getWorktreeStatus({ worktreePath: branchPath })).isDirty === false
        }).pipe(Effect.orElseSucceed(() => false))
        if (reusable === true) return { _tag: 'branch' as const, ref: targetRef }
      } else if ((yield* fs.exists(branchPath)) === false) {
        // Creating a missing worktree does not advance the local branch ref.
        const branchHead = yield* Git.resolveRef({
          repoPath: bareRepoPath,
          ref: `refs/heads/${targetRef}`,
        }).pipe(Effect.option)
        if (Option.isSome(branchHead) === true && branchHead.value === targetCommit) {
          return { _tag: 'branch' as const, ref: targetRef }
        }
      }
      return { _tag: 'commit' as const, commit: targetCommit }
    })
    let worktreeRef: string =
      worktreeSelection._tag === 'commit' ? worktreeSelection.commit : worktreeSelection.ref
    let worktreeRefType: RefType =
      worktreeSelection._tag === 'commit'
        ? 'commit'
        : worktreeSelection._tag === 'branch'
          ? 'branch'
          : worktreeSelection.refType

    const worktreePath = yield* resolveWorktreePath({
      ref: worktreeRef,
      refType: worktreeRefType,
    })

    // A visible .git can belong to a creator still running under the lock.
    // Every commit visitor must join that flight before using its freshness.
    if (
      dryRun === false &&
      (worktreeRefType === 'commit' || (yield* worktreePathExists(worktreePath)) === false)
    ) {
      yield* storeLock
        .withWorktreeLock(yield* canonicalizeStorePath(worktreePath))(
          Effect.gen(function* () {
            // Double-check inside lock (another process/fiber may have created it)
            const resolvedWorktreePath = yield* resolveWorktreePath({
              ref: worktreeRef,
              refType: worktreeRefType,
            })
            const stillNotExists = (yield* worktreePathExists(resolvedWorktreePath)) === false
            if (stillNotExists === false) return

            // A commit target is safe to replace only when its physical identity is
            // unregistered and the target itself is an empty real directory.
            if (worktreeRefType === 'commit') {
              yield* removeEmptyUnregisteredCommitWorktreeRemnant({
                bareRepoPath,
                worktreePath,
              })
            } else {
              // Preserve the existing recovery policy for mutable branch and tag targets.
              const dirExists = yield* fs.exists(worktreePath)
              if (dirExists === true) {
                yield* assertCanonicalMutationAllowed({ target: worktreePath })
                yield* fs.remove(worktreePath, { recursive: true })
                yield* Git.pruneWorktrees(bareRepoPath)
              }
            }

            // Ensure worktree parent directory exists
            const worktreeParent = EffectPath.ops.parent(worktreePath)
            if (worktreeParent !== undefined) {
              yield* makeStoreDirectory(worktreeParent)
            }

            // Create worktree
            if (worktreeRefType === 'commit' || worktreeRefType === 'tag') {
              yield* createStoreWorktreeDetached({
                storeBasePath: store.basePath,
                repoPath: bareRepoPath,
                worktreePath,
                commit: targetCommit ?? worktreeRef,
              })
              if (isApplyMode === true && worktreeRefType === 'commit') {
                onWorktreeCreated?.(yield* fs.realPath(worktreePath))
              }
            } else {
              yield* createStoreWorktree({
                storeBasePath: store.basePath,
                repoPath: bareRepoPath,
                worktreePath,
                branch: targetRef,
                createBranch: false,
              }).pipe(
                Effect.catch(() =>
                  createStoreWorktree({
                    storeBasePath: store.basePath,
                    repoPath: bareRepoPath,
                    worktreePath,
                    branch: `origin/${targetRef}`,
                    createBranch: false,
                  }),
                ),
              )
            }
          }),
        )
        .pipe(
          Observability.withSyncMemberCreateWorktreeSpan({
            ref: worktreeRef,
            refType: worktreeRefType,
          }),
        )
    }

    /** Fallback: switch to a commit worktree, creating it if needed. */
    const ensureCommitWorktree = () =>
      Effect.gen(function* () {
        worktreeRef = targetCommit!
        worktreeRefType = 'commit'
        const commitWorktreePath = store.getWorktreePath({
          source,
          ref: targetCommit!,
          refType: 'commit',
        })
        yield* storeLock.withWorktreeLock(yield* canonicalizeStorePath(commitWorktreePath))(
          Effect.gen(function* () {
            const exists = yield* store.hasWorktree({
              source,
              ref: targetCommit!,
              refType: 'commit',
            })
            if (exists === true) return

            yield* removeEmptyUnregisteredCommitWorktreeRemnant({
              bareRepoPath,
              worktreePath: commitWorktreePath,
            })

            const parent = EffectPath.ops.parent(commitWorktreePath)
            if (parent !== undefined) {
              yield* makeStoreDirectory(parent)
            }
            yield* createStoreWorktreeDetached({
              storeBasePath: store.basePath,
              repoPath: bareRepoPath,
              worktreePath: commitWorktreePath,
              commit: targetCommit!,
            })
            if (isApplyMode === true) {
              onWorktreeCreated?.(yield* fs.realPath(commitWorktreePath))
            }
          }),
        )
      })

    // Re-check branch admission after creation: a concurrently changed canonical
    // worktree is left untouched and the mount falls back to the locked commit.
    if (
      isApplyMode === true &&
      dryRun === false &&
      worktreeRefType === 'branch' &&
      targetCommit !== undefined
    ) {
      // Branch identity, exact HEAD, and a clean tree are all required for reuse.
      const worktreeBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )
      const onExpectedBranch =
        Option.isSome(worktreeBranch) === true && worktreeBranch.value === targetRef

      const currentCommit = yield* Git.getCurrentCommit(worktreePath)
      const worktreeStatus = yield* Git.getWorktreeStatus({ worktreePath })
      if (
        onExpectedBranch === false ||
        currentCommit !== targetCommit ||
        worktreeStatus.isDirty === true
      ) {
        yield* ensureCommitWorktree()
      }
    }

    // Recompute worktree path from the final ref/type (may have changed due to commit fallback)
    const finalWorktreePath = yield* resolveWorktreePath({
      ref: worktreeRef,
      refType: worktreeRefType,
    })
    // Create symlink from workspace to worktree
    const existingLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.orElseSucceed(() => null))
    if (existingLink !== null) {
      if (existingLink.replace(/\/$/, '') === finalWorktreePath.replace(/\/$/, '')) {
        return {
          name,
          status: 'already_synced',
          commit: targetCommit,
          ref: targetRef,
        } satisfies MemberSyncResult
      }
      if (dryRun === false) {
        yield* fs.remove(memberPathNormalized)
      }
    } else {
      const exists = yield* fs.exists(memberPathNormalized).pipe(Effect.orElseSucceed(() => false))
      if (exists === true) {
        return {
          name,
          status: 'error',
          message: foreignMemberMountMessage({
            name,
            path: memberPathNormalized,
            operation: 'replace',
          }),
        } satisfies MemberSyncResult
      }
    }

    if (dryRun === false) {
      yield* createSymlink({
        target: finalWorktreePath,
        link: memberPathNormalized,
      })
    }

    // Determine if this is a lock update (changed commit)
    const previousCommit = lockedMember?.commit
    const isUpdate =
      isApplyMode === true && previousCommit !== undefined && previousCommit !== targetCommit

    // Build message for branch creation
    const branchCreatedMessage =
      needsCreateBranch === true && defaultBranchForCreate !== undefined
        ? `created branch '${targetRef}' from '${defaultBranchForCreate}'`
        : undefined

    return {
      name,
      status: wasCloned === true ? 'cloned' : isUpdate === true ? 'updated' : 'applied',
      commit: targetCommit,
      previousCommit: isUpdate === true ? previousCommit : undefined,
      ref: targetRef,
      lockUpdated: isLockMode === true ? true : undefined,
      message: branchCreatedMessage,
    } satisfies MemberSyncResult
  }).pipe(
    Effect.tap((result) => Observability.annotateSyncMemberResult(result.status)),
    Effect.catch((error) => {
      // Interpret git errors to provide user-friendly messages
      if (error instanceof Git.GitCommandError) {
        const interpreted = Git.interpretGitError(error)
        const message =
          interpreted.hint !== undefined
            ? `${interpreted.message}\n  hint: ${interpreted.hint}`
            : interpreted.message
        return Effect.gen(function* () {
          yield* Observability.annotateSyncMemberResult('error')
          return {
            name,
            status: 'error',
            message,
          } satisfies MemberSyncResult
        })
      }
      return Effect.gen(function* () {
        yield* Observability.annotateSyncMemberResult('error')
        return {
          name,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        } satisfies MemberSyncResult
      })
    }),
    Observability.withSyncMemberSpan({ name, source: sourceString }),
  )
