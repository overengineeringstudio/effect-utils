/**
 * Member Sync
 *
 * Sync a single member using the bare repo + worktree pattern.
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  getMemberPath,
  getSourceRef,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../config.ts'
import * as Git from '../git.ts'
import type { LockFile } from '../lock.ts'
import { classifyRef } from '../ref.ts'
import { Store } from '../store.ts'
import type { MemberSyncResult } from './types.ts'

/**
 * Get the git clone URL for a member source
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
 * Create a symlink, stripping trailing slashes from paths.
 * POSIX symlink fails with ENOENT if the link path ends with `/`.
 */
const createSymlink = ({ target, link }: { target: string; link: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.symlink(target.replace(/\/$/, ''), link.replace(/\/$/, ''))
  })

/**
 * Sync a single member: use bare repo + worktree pattern
 *
 * Modes:
 * - Default: ensure member exists, read current HEAD to update lock
 * - Pull: fetch from remote, update to latest (unless pinned)
 * - Frozen: use exact commit from lock, never modify lock
 */
export const syncMember = ({
  name,
  sourceString,
  megarepoRoot,
  lockFile,
  dryRun,
  pull,
  frozen,
  force,
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  dryRun: boolean
  pull: boolean
  frozen: boolean
  force: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store

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

    // Handle local path sources - just create symlink
    if (source.type === 'path') {
      const expandedPath = source.path.replace(/^~/, process.env.HOME ?? '~')
      const resolvedPath = path.isAbsolute(expandedPath)
        ? expandedPath
        : path.resolve(megarepoRoot, expandedPath)
      const existingLink = yield* fs
        .readLink(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (existingLink !== null) {
        if (existingLink.replace(/\/$/, '') === resolvedPath.replace(/\/$/, '')) {
          return { name, status: 'already_synced' } satisfies MemberSyncResult
        }
        if (!dryRun) {
          yield* fs.remove(memberPathNormalized)
        }
      } else {
        const exists = yield* fs
          .exists(memberPathNormalized)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists) {
          return {
            name,
            status: 'skipped',
            message: 'Directory exists but is not a symlink',
          } satisfies MemberSyncResult
        }
      }

      if (!dryRun) {
        yield* createSymlink({
          target: resolvedPath,
          link: memberPathNormalized,
        })
      }

      return { name, status: 'synced' } satisfies MemberSyncResult
    }

    // For remote sources, use bare repo + worktree pattern
    const cloneUrl = getCloneUrl(source)
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

    // Check lock file first (for --frozen mode or to use locked commit)
    const lockedMember = lockFile?.members[name]
    if (frozen) {
      if (lockedMember === undefined) {
        return {
          name,
          status: 'error',
          message: 'Not in lock file (--frozen requires lock file)',
        } satisfies MemberSyncResult
      }
      targetRef = lockedMember.ref
      targetCommit = lockedMember.commit
    } else if (lockedMember !== undefined && lockedMember.pinned) {
      // Use pinned commit from lock
      targetRef = lockedMember.ref
      targetCommit = lockedMember.commit
    } else {
      // Use ref from source string, or determine default
      const sourceRef = getSourceRef(source)
      if (Option.isSome(sourceRef)) {
        targetRef = sourceRef.value
      } else {
        // Need to determine default branch
        if (bareExists) {
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

    // Check if member symlink already exists and points to a valid worktree
    const currentLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const memberExists = currentLink !== null

    // In default mode (no --pull), if member exists, just read current state for lock
    if (memberExists && !pull && !frozen) {
      // Read current HEAD from the worktree
      const currentCommit = yield* Git.getCurrentCommit(memberPathNormalized).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      const currentBranchOpt = yield* Git.getCurrentBranch(memberPathNormalized).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      const currentBranch = Option.getOrUndefined(currentBranchOpt)

      // Determine if lock needs updating
      const previousCommit = lockedMember?.commit
      const lockUpdated = currentCommit !== undefined && currentCommit !== previousCommit

      return {
        name,
        status: lockUpdated ? 'locked' : 'already_synced',
        commit: currentCommit,
        previousCommit: lockUpdated ? previousCommit : undefined,
        ref: currentBranch ?? lockedMember?.ref ?? targetRef,
        lockUpdated,
      } satisfies MemberSyncResult
    }

    // For --pull mode, check if worktree is dirty before making changes
    if (pull && memberExists && !frozen && !dryRun) {
      const worktreeStatus = yield* Git.getWorktreeStatus(currentLink).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            isDirty: false,
            hasUnpushed: false,
            changesCount: 0,
          }),
        ),
      )
      if ((worktreeStatus.isDirty || worktreeStatus.hasUnpushed) && !force) {
        return {
          name,
          status: 'skipped',
          message: worktreeStatus.isDirty
            ? `${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
            : 'has unpushed commits (use --force to override)',
        } satisfies MemberSyncResult
      }
    }

    // Clone bare repo if needed
    // Note: --frozen mode still allows cloning - it only prevents updating the lock file.
    // This enables CI to materialize the locked state in a fresh environment.
    let wasCloned = false
    if (!bareExists) {
      if (!dryRun) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
        wasCloned = true
      }
    } else if (pull && !dryRun) {
      // Fetch when --pull is specified (includes frozen mode - frozen only prevents lock updates)
      yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
        Effect.catchAll(() => Effect.void), // Ignore fetch errors
      )
    } else if (frozen && targetCommit !== undefined && !dryRun) {
      // In frozen mode, fetch if the locked commit is not available locally
      // This ensures we can materialize the exact locked state even if the store is stale
      const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
      if (!commitExists) {
        yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
    }

    // Resolve ref to commit if not already known
    if (targetCommit === undefined && !dryRun) {
      const refType = classifyRef(targetRef)
      if (refType === 'commit') {
        targetCommit = targetRef
      } else if (refType === 'tag') {
        targetCommit = yield* Git.resolveRef({
          repoPath: bareRepoPath,
          ref: `refs/tags/${targetRef}`,
        }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
      } else {
        // Branch - resolve to HEAD of branch
        targetCommit = yield* Git.resolveRef({
          repoPath: bareRepoPath,
          ref: `refs/remotes/origin/${targetRef}`,
        }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
      }
    }

    // Create or update worktree
    // For frozen/pinned mode, use commit-based worktree path to guarantee exact reproducibility
    // This ensures the worktree is at exactly the locked commit, not whatever a branch points to
    const useCommitBasedPath = (frozen || lockedMember?.pinned) && targetCommit !== undefined
    // TypeScript note: when useCommitBasedPath is true, targetCommit is guaranteed to be defined
    const worktreeRef: string = useCommitBasedPath ? targetCommit! : targetRef
    const worktreePath = store.getWorktreePath({ source, ref: worktreeRef })
    const worktreeExists = yield* store.hasWorktree({
      source,
      ref: worktreeRef,
    })

    if (!worktreeExists && !dryRun) {
      // Ensure worktree parent directory exists
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create worktree
      // Use worktreeRef for classification - if commit-based path, always create detached
      const refType = classifyRef(worktreeRef)
      if (refType === 'commit' || refType === 'tag') {
        // Commit or tag: create detached worktree
        yield* Git.createWorktreeDetached({
          repoPath: bareRepoPath,
          worktreePath,
          commit: targetCommit ?? worktreeRef,
        })
      } else {
        // Branch worktree - can track the branch
        yield* Git.createWorktree({
          repoPath: bareRepoPath,
          worktreePath,
          branch: targetRef,
          createBranch: false,
        }).pipe(
          Effect.catchAll(() =>
            // If branch doesn't exist locally, create from remote
            Git.createWorktree({
              repoPath: bareRepoPath,
              worktreePath,
              branch: `origin/${targetRef}`,
              createBranch: false,
            }),
          ),
          Effect.catchAll(() =>
            // Last resort: create detached at the resolved commit
            Git.createWorktreeDetached({
              repoPath: bareRepoPath,
              worktreePath,
              commit: targetCommit ?? targetRef,
            }),
          ),
        )
      }
    }

    // Create symlink from workspace to worktree
    const existingLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (existingLink !== null) {
      if (existingLink.replace(/\/$/, '') === worktreePath.replace(/\/$/, '')) {
        return {
          name,
          status: 'already_synced',
          commit: targetCommit,
          ref: targetRef,
        } satisfies MemberSyncResult
      }
      if (!dryRun) {
        yield* fs.remove(memberPathNormalized)
      }
    } else {
      const exists = yield* fs
        .exists(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (exists) {
        return {
          name,
          status: 'skipped',
          message: 'Directory exists but is not a symlink',
        } satisfies MemberSyncResult
      }
    }

    if (!dryRun) {
      yield* createSymlink({
        target: worktreePath,
        link: memberPathNormalized,
      })
    }

    // Determine if this is a pull update (changed commit)
    const previousCommit = lockedMember?.commit
    const isUpdate = pull && previousCommit !== undefined && previousCommit !== targetCommit

    return {
      name,
      status: wasCloned ? 'cloned' : isUpdate ? 'updated' : 'synced',
      commit: targetCommit,
      previousCommit: isUpdate ? previousCommit : undefined,
      ref: targetRef,
      lockUpdated: true,
    } satisfies MemberSyncResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies MemberSyncResult),
    ),
  )
