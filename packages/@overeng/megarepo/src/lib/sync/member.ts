/**
 * Member Sync
 *
 * Sync a single member using the bare repo + worktree pattern.
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Option, Ref } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  getMemberPath,
  getSourceRef,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../config.ts'
import * as Git from '../git.ts'
import { detectRefMismatch, formatRefMismatchMessage } from '../issues.ts'
import type { LockFile } from '../lock.ts'
import { classifyRef, extractRefFromSymlinkPath, isCommitSha, type RefType } from '../ref.ts'
import { Store } from '../store.ts'
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
 * Internal semaphore type from Effect
 */
type Semaphore = Effect.Semaphore

/**
 * Map of repo URL -> semaphore for serializing bare repo creation.
 * This prevents race conditions when multiple members use the same underlying repo.
 *
 * We use a Ref to ensure atomic get-or-create operations, preventing race conditions
 * when multiple fibers concurrently request a semaphore for the same URL.
 */
export type RepoSemaphoreMap = Ref.Ref<Map<string, Semaphore>>

/**
 * Create a new repo semaphore map.
 */
export const makeRepoSemaphoreMap = (): Effect.Effect<RepoSemaphoreMap> =>
  Ref.make(new Map<string, Semaphore>())

/**
 * Get or create a semaphore for a given repo URL.
 * Uses Ref.modify for atomic check-and-set to prevent race conditions.
 */
export const getRepoSemaphore = ({
  semaphoreMapRef,
  url,
}: {
  semaphoreMapRef: RepoSemaphoreMap
  url: string
}): Effect.Effect<Semaphore> =>
  Ref.modify(semaphoreMapRef, (map) => {
    const existing = map.get(url)
    if (existing !== undefined) {
      return [existing, map]
    }
    // Create new semaphore and add to map
    const sem = Effect.unsafeMakeSemaphore(1)
    const newMap = new Map(map)
    newMap.set(url, sem)
    return [sem, newMap]
  })

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

/**
 * Sync a single member: use bare repo + worktree pattern
 *
 * Modes:
 * - workspace: ensure members exist at source refs, never update the lock
 * - lock_sync: record the current synced workspace into the lock
 * - lock_update: fetch source refs, update workspace, then update the lock
 * - lock_apply: apply the exact lock file state (CI mode)
 */
export const syncMember = <R = never>({
  name,
  sourceString,
  megarepoRoot,
  lockFile,
  mode,
  dryRun,
  force,
  semaphoreMap,
  gitProtocol = 'auto',
  createBranches = false,
  onMissingRef,
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  mode: SyncMode
  dryRun: boolean
  force: boolean
  /** Optional semaphore map for serializing bare repo creation per repo URL */
  semaphoreMap?: RepoSemaphoreMap
  /** Git protocol to use for cloning: 'ssh', 'https', or 'auto' (default) */
  gitProtocol?: GitProtocol
  /** Create branches that don't exist (from default branch) */
  createBranches?: boolean
  /** Callback when a ref doesn't exist. If not provided, defaults to 'error' behavior. */
  onMissingRef?: (info: MissingRefInfo) => Effect.Effect<MissingRefAction, never, R>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store
    const isWorkspaceMode = mode === 'workspace'
    const isLockSyncMode = mode === 'lock_sync'
    const isLockUpdateMode = mode === 'lock_update'
    const isLockApplyMode = mode === 'lock_apply'

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
      const resolvedPath =
        path.isAbsolute(expandedPath) === true
          ? expandedPath
          : path.resolve(megarepoRoot, expandedPath)
      const existingLink = yield* fs
        .readLink(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (existingLink !== null) {
        if (existingLink.replace(/\/$/, '') === resolvedPath.replace(/\/$/, '')) {
          return { name, status: 'already_synced' } satisfies MemberSyncResult
        }
        // Path changed - check if old worktree has uncommitted changes before switching
        if (force === false && dryRun === false) {
          const worktreeStatus = yield* Git.getWorktreeStatus(existingLink).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                isDirty: false,
                hasUnpushed: false,
                changesCount: 0,
              }),
            ),
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
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists === true) {
          return {
            name,
            status: 'skipped',
            message: 'Directory exists but is not a symlink',
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
    if (isLockApplyMode === true) {
      if (lockedMember === undefined) {
        return {
          name,
          status: 'error',
          message: 'Not in lock file (mr lock apply requires lock file)',
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

    if (isLockUpdateMode === true && lockedMember?.pinned === true && force === false) {
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
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const memberExists = currentLink !== null

    // In workspace/lock-sync modes, if member exists, check if symlink points to correct ref
    if (memberExists === true && isLockUpdateMode === false && isLockApplyMode === false) {
      // Compute expected worktree path based on configured ref
      // Uses heuristic ref classification since we haven't queried the repo yet
      const expectedWorktreePath = store.getWorktreePath({ source, ref: targetRef })
      const currentLinkNormalized = currentLink?.replace(/\/$/, '')
      const expectedPathNormalized = expectedWorktreePath.replace(/\/$/, '')

      // Lock sync only records current branch-attached workspace state.
      if (isLockSyncMode === true && currentLinkNormalized !== expectedPathNormalized) {
        // Extract the ref from the current symlink path for display
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
            `  hint: run 'mr sync${name.length > 0 ? ` --only ${name}` : ''}' first`,
        } satisfies MemberSyncResult
      }

      // If symlink points to correct location, read current state.
      if (currentLinkNormalized === expectedPathNormalized) {
        // Read current HEAD from the worktree
        const currentCommitOpt = yield* Git.getCurrentCommit(memberPathNormalized).pipe(
          Effect.option,
        )
        const currentCommit = Option.getOrUndefined(currentCommitOpt)
        const currentBranchOpt = yield* Git.getCurrentBranch(memberPathNormalized).pipe(
          Effect.catchAll(() => Effect.succeed(Option.none<string>())),
        )
        const currentBranch = Option.getOrUndefined(currentBranchOpt)

        // Check for ref mismatch (invariant #8 violation)
        // This happens when user runs `git checkout <other-branch>` directly in the worktree
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

        if (isWorkspaceMode === true) {
          return {
            name,
            status: 'already_synced',
            commit: currentCommit,
            ref: currentBranch ?? targetRef,
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

      // Symlink points to wrong location (ref changed in config)
      // Check if old worktree has uncommitted changes before switching
      if (force === false && dryRun === false) {
        const worktreeStatus = yield* Git.getWorktreeStatus(currentLink).pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              isDirty: false,
              hasUnpushed: false,
              changesCount: 0,
            }),
          ),
        )
        if (worktreeStatus.isDirty === true || worktreeStatus.hasUnpushed === true) {
          return {
            name,
            status: 'skipped',
            message:
              worktreeStatus.isDirty === true
                ? `ref changed but old worktree has ${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
                : 'ref changed but old worktree has unpushed commits (use --force to override)',
          } satisfies MemberSyncResult
        }
      }
      // Fall through to update symlink to new ref
    }

    // For lock update mode, check if worktree is dirty before making changes
    if (isLockUpdateMode === true && memberExists === true && dryRun === false) {
      const worktreeStatus = yield* Git.getWorktreeStatus(currentLink).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            isDirty: false,
            hasUnpushed: false,
            changesCount: 0,
          }),
        ),
      )
      if (
        (worktreeStatus.isDirty === true || worktreeStatus.hasUnpushed === true) &&
        force === false
      ) {
        return {
          name,
          status: 'skipped',
          message:
            worktreeStatus.isDirty === true
              ? `${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
              : 'has unpushed commits (use --force to override)',
        } satisfies MemberSyncResult
      }
    }

    if (isLockSyncMode === true && memberExists === false) {
      return {
        name,
        status: 'skipped',
        message: `workspace member missing for '${targetRef}'\n  hint: run 'mr sync${name.length > 0 ? ` --only ${name}` : ''}' first`,
      } satisfies MemberSyncResult
    }

    // Clone bare repo if needed.
    let wasCloned = false
    if (bareExists === false) {
      if (dryRun === false) {
        // Use semaphore to serialize bare repo creation for the same repo URL.
        // This prevents race conditions when multiple members reference the same repo.
        const createBareRepo = Effect.gen(function* () {
          // Check again inside semaphore (double-check locking pattern)
          const stillNotExists = (yield* store.hasBareRepo(source)) === false
          if (stillNotExists === true) {
            const repoBasePath = store.getRepoBasePath(source)
            yield* fs.makeDirectory(repoBasePath, { recursive: true })
            yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
            return true
          }
          return false
        })

        if (semaphoreMap !== undefined) {
          const sem = yield* getRepoSemaphore({ semaphoreMapRef: semaphoreMap, url: cloneUrl })
          wasCloned = yield* sem.withPermits(1)(createBareRepo)
        } else {
          wasCloned = yield* createBareRepo
        }
      }
    } else if (isLockUpdateMode === true && dryRun === false) {
      // Fetch when lock update is requested.
      yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
        Effect.catchAll(() => Effect.void), // Ignore fetch errors
      )
    } else if (isLockApplyMode === true && targetCommit !== undefined && dryRun === false) {
      // Lock apply fetches missing commits to materialize the exact locked state.
      const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
      if (commitExists === false) {
        yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))
      }
    }

    /**
     * A lock entry can point at an object that disappeared after a force-push.
     * In lock update mode we can recover branch-based members by re-resolving `targetRef`,
     * but pinned commit-SHA refs remain hard failures because there is no mutable ref to follow.
     */
    if (dryRun === false && targetCommit !== undefined) {
      const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
      if (commitExists === false) {
        const shortCommit = targetCommit.slice(0, 8)

        if (isLockApplyMode === true) {
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

    // Validate that the ref exists (for dry-run mode or before creating worktree)
    // Uses hybrid approach: check local bare repo if exists, otherwise query remote
    // Track whether we need to create the branch
    let needsCreateBranch = false
    let defaultBranchForCreate: string | undefined

    if (targetCommit === undefined && isCommitSha(targetRef) === false) {
      const refValidation = yield* Git.validateRefExists({
        ref: targetRef,
        bareRepoPath: bareExists === true ? bareRepoPath : undefined,
        bareExists,
        cloneUrl,
      })
      if (refValidation.exists === false) {
        // Get default branch to use as base (needed for both createBranches and interactive prompt)
        if (bareExists === true) {
          const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
          defaultBranchForCreate = Option.getOrElse(defaultBranch, () => 'main')
        } else {
          const defaultBranch = yield* Git.getDefaultBranch({ url: cloneUrl })
          defaultBranchForCreate = Option.getOrElse(defaultBranch, () => 'main')
        }

        // Determine action: --create-branches flag, interactive prompt, or error
        let action: MissingRefAction = 'error'

        if (createBranches === true) {
          action = 'create'
        } else if (onMissingRef !== undefined) {
          // Interactive mode - ask user what to do
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
              // In dry-run mode, report what would happen
              return {
                name,
                status: 'synced',
                ref: targetRef,
                message: `would create branch '${targetRef}' from '${defaultBranchForCreate}'`,
              } satisfies MemberSyncResult
            }
            break
          case 'skip':
            return {
              name,
              status: 'skipped',
              message: `branch '${targetRef}' does not exist`,
            } satisfies MemberSyncResult
          case 'abort':
            return {
              name,
              status: 'error',
              message: `Sync aborted: branch '${targetRef}' does not exist`,
            } satisfies MemberSyncResult
          case 'error':
          default:
            return {
              name,
              status: 'error',
              message: `Ref '${targetRef}' not found\n  hint: Check available refs with: git ls-remote --refs ${cloneUrl}\n  hint: Use --create-branches to create missing branches`,
            } satisfies MemberSyncResult
        }
      }
    }

    // Create branch if needed (--create-branches flag was used and ref doesn't exist)
    if (needsCreateBranch === true && defaultBranchForCreate !== undefined && dryRun === false) {
      // Create the branch locally and push to remote
      // Note: In bare repos, branches are at refs/heads/<branch>, not refs/remotes/origin/<branch>
      yield* Git.createAndPushBranch({
        repoPath: bareRepoPath,
        branch: targetRef,
        baseRef: defaultBranchForCreate,
      })
    }

    // Resolve ref to commit if not already known
    // Use actual ref type from local repo query for accurate classification
    let actualRefType: RefType = classifyRef(targetRef) // fallback to heuristic
    if (targetCommit === undefined && dryRun === false) {
      // If it's already a commit SHA, use it directly
      if (isCommitSha(targetRef) === true) {
        targetCommit = targetRef
        actualRefType = 'commit'
      } else {
        // Query local repo for actual ref type (more accurate than heuristic)
        const refInfo = yield* Git.queryLocalRefType({
          repoPath: bareRepoPath,
          ref: targetRef,
        })

        if (refInfo.type === 'tag') {
          actualRefType = 'tag'
          targetCommit = yield* Git.resolveRef({
            repoPath: bareRepoPath,
            ref: `refs/tags/${targetRef}`,
          }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
        } else if (refInfo.type === 'branch') {
          actualRefType = 'branch'
          targetCommit = yield* Git.resolveRef({
            repoPath: bareRepoPath,
            ref: `refs/remotes/origin/${targetRef}`,
          }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
        } else {
          // Unknown ref type - fall back to heuristic-based resolution
          const heuristicType = classifyRef(targetRef)
          actualRefType = heuristicType
          if (heuristicType === 'tag') {
            targetCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/tags/${targetRef}`,
            }).pipe(
              Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
            )
          } else {
            // Treat as branch
            targetCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/remotes/origin/${targetRef}`,
            }).pipe(
              Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
            )
          }
        }
      }
    }

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

    // Create or update worktree.
    // Lock apply intentionally materializes commit-based branch worktrees for reproducibility.
    const useCommitBasedPath = isLockApplyMode === true && targetCommit !== undefined
    // TypeScript note: when useCommitBasedPath is true, targetCommit is guaranteed to be defined
    const worktreeRef: string = useCommitBasedPath === true ? targetCommit! : targetRef
    // Use the actual ref type for accurate store path classification
    const worktreeRefType = useCommitBasedPath === true ? ('commit' as const) : actualRefType
    const worktreePath = store.getWorktreePath({
      source,
      ref: worktreeRef,
      refType: worktreeRefType,
    })
    const worktreeExists = yield* store.hasWorktree({
      source,
      ref: worktreeRef,
      refType: worktreeRefType,
    })

    if (worktreeExists === false && dryRun === false) {
      // Ensure worktree parent directory exists
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create worktree
      // Use the actual ref type determined earlier, or check if using commit-based path
      const createWorktreeRefType = useCommitBasedPath === true ? 'commit' : actualRefType
      if (createWorktreeRefType === 'commit' || createWorktreeRefType === 'tag') {
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
        )
      }
    }

    // Fast-forward existing branch worktrees when updating from remote.
    let remoteUpdated = false
    let remotePreviousCommit: string | undefined
    if (
      worktreeExists === true &&
      isLockUpdateMode === true &&
      dryRun === false &&
      actualRefType === 'branch' &&
      useCommitBasedPath === false
    ) {
      // Verify the worktree is actually on the expected branch before merging.
      // If the user ran `git checkout <other-branch>` inside the worktree,
      // we must not merge into the wrong branch.
      const worktreeBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      const onExpectedBranch = Option.isSome(worktreeBranch) && worktreeBranch.value === targetRef

      if (onExpectedBranch === true) {
        const currentCommitOpt = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
        const currentCommit = Option.getOrUndefined(currentCommitOpt)
        if (
          currentCommit !== undefined &&
          targetCommit !== undefined &&
          currentCommit !== targetCommit
        ) {
          // Capture narrowed value for use in closures
          const resolvedCommit = targetCommit
          // Merge by exact commit SHA to avoid hard-coding remote name
          yield* Git.mergeFFOnly({ worktreePath, ref: resolvedCommit }).pipe(
            Effect.mapError(
              (error) =>
                new Git.GitCommandError({
                  args: ['merge', '--ff-only', resolvedCommit],
                  exitCode: 1,
                  stderr:
                    error instanceof Git.GitCommandError
                      ? `Cannot fast-forward worktree to ${resolvedCommit.slice(0, 8)}: ${error.stderr}`
                      : `Cannot fast-forward worktree to ${resolvedCommit.slice(0, 8)}`,
                }),
            ),
          )
          // Re-read HEAD to confirm actual state after merge
          const headAfterMerge = yield* Git.getCurrentCommit(worktreePath)
          targetCommit = headAfterMerge
          remotePreviousCommit = currentCommit
          remoteUpdated = true
        }
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
          status: isLockApplyMode === true
            ? 'already_synced'
            : remoteUpdated === true
              ? 'updated'
              : 'already_synced',
          commit: targetCommit,
          previousCommit: remotePreviousCommit,
          ref: targetRef,
          lockUpdated:
            isLockSyncMode === true || isLockUpdateMode === true
              ? remoteUpdated === true
                ? true
                : undefined
              : undefined,
        } satisfies MemberSyncResult
      }
      if (dryRun === false) {
        yield* fs.remove(memberPathNormalized)
      }
    } else {
      const exists = yield* fs
        .exists(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (exists === true) {
        return {
          name,
          status: 'skipped',
          message: 'Directory exists but is not a symlink',
        } satisfies MemberSyncResult
      }
    }

    if (dryRun === false) {
      yield* createSymlink({
        target: worktreePath,
        link: memberPathNormalized,
      })
    }

    // Determine if this is a lock update (changed commit)
    const previousCommit = lockedMember?.commit
    const isUpdate =
      isLockUpdateMode === true && previousCommit !== undefined && previousCommit !== targetCommit

    // Build message for branch creation
    const branchCreatedMessage =
      needsCreateBranch === true && defaultBranchForCreate !== undefined
        ? `created branch '${targetRef}' from '${defaultBranchForCreate}'`
        : undefined

    return {
      name,
      status: isLockApplyMode === true
        ? 'applied'
        : wasCloned === true
          ? 'cloned'
          : isUpdate === true
            ? 'updated'
            : 'synced',
      commit: targetCommit,
      previousCommit: isUpdate === true ? previousCommit : undefined,
      ref: targetRef,
      lockUpdated: isLockSyncMode === true || isLockUpdateMode === true ? true : undefined,
      message: branchCreatedMessage,
    } satisfies MemberSyncResult
  }).pipe(
    Effect.catchAll((error) => {
      // Interpret git errors to provide user-friendly messages
      if (error instanceof Git.GitCommandError) {
        const interpreted = Git.interpretGitError(error)
        const message =
          interpreted.hint !== undefined
            ? `${interpreted.message}\n  hint: ${interpreted.hint}`
            : interpreted.message
        return Effect.succeed({
          name,
          status: 'error',
          message,
        } satisfies MemberSyncResult)
      }
      return Effect.succeed({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies MemberSyncResult)
    }),
  )
