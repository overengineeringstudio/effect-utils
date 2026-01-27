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
import type { LockFile } from '../lock.ts'
import { classifyRef, isCommitSha, type RefType } from '../ref.ts'
import { Store } from '../store.ts'
import type { MemberSyncResult } from './types.ts'

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
  semaphoreMap,
  gitProtocol = 'auto',
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  dryRun: boolean
  pull: boolean
  frozen: boolean
  force: boolean
  /** Optional semaphore map for serializing bare repo creation per repo URL */
  semaphoreMap?: RepoSemaphoreMap
  /** Git protocol to use for cloning: 'ssh', 'https', or 'auto' (default) */
  gitProtocol?: GitProtocol
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
        // Path changed - check if old worktree has uncommitted changes before switching
        if (!force && !dryRun) {
          const worktreeStatus = yield* Git.getWorktreeStatus(existingLink).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                isDirty: false,
                hasUnpushed: false,
                changesCount: 0,
              }),
            ),
          )
          if (worktreeStatus.isDirty || worktreeStatus.hasUnpushed) {
            return {
              name,
              status: 'skipped',
              message: worktreeStatus.isDirty
                ? `path changed but old worktree has ${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
                : 'path changed but old worktree has unpushed commits (use --force to override)',
            } satisfies MemberSyncResult
          }
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

    // Check lock file first (for --frozen mode or to use locked commit)
    // Note: lockedMember was already retrieved above for resolveCloneUrl
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

    // In default mode (no --pull), if member exists, check if symlink points to correct ref
    if (memberExists && !pull && !frozen) {
      // Compute expected worktree path based on configured ref
      // Uses heuristic ref classification since we haven't queried the repo yet
      const expectedWorktreePath = store.getWorktreePath({ source, ref: targetRef })
      const currentLinkNormalized = currentLink?.replace(/\/$/, '')
      const expectedPathNormalized = expectedWorktreePath.replace(/\/$/, '')

      // If symlink points to correct location, just read current state for lock
      if (currentLinkNormalized === expectedPathNormalized) {
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

      // Symlink points to wrong location (ref changed in config)
      // Check if old worktree has uncommitted changes before switching
      if (!force && !dryRun) {
        const worktreeStatus = yield* Git.getWorktreeStatus(currentLink).pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              isDirty: false,
              hasUnpushed: false,
              changesCount: 0,
            }),
          ),
        )
        if (worktreeStatus.isDirty || worktreeStatus.hasUnpushed) {
          return {
            name,
            status: 'skipped',
            message: worktreeStatus.isDirty
              ? `ref changed but old worktree has ${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
              : 'ref changed but old worktree has unpushed commits (use --force to override)',
          } satisfies MemberSyncResult
        }
      }
      // Fall through to update symlink to new ref
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
        // Use semaphore to serialize bare repo creation for the same repo URL.
        // This prevents race conditions when multiple members reference the same repo.
        const createBareRepo = Effect.gen(function* () {
          // Check again inside semaphore (double-check locking pattern)
          const stillNotExists = !(yield* store.hasBareRepo(source))
          if (stillNotExists) {
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
    // Use actual ref type from local repo query for accurate classification
    let actualRefType: RefType = classifyRef(targetRef) // fallback to heuristic
    if (targetCommit === undefined && !dryRun) {
      // If it's already a commit SHA, use it directly
      if (isCommitSha(targetRef)) {
        targetCommit = targetRef
        actualRefType = 'commit'
      } else {
        // Query local repo for actual ref type (more accurate than heuristic)
        const refInfo = yield* Git.queryLocalRefType({
          repoPath: bareRepoPath,
          ref: targetRef,
        }).pipe(Effect.catchAll(() => Effect.succeed({ type: 'unknown' as const, commit: '' })))

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
            }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
          } else {
            // Treat as branch
            targetCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/remotes/origin/${targetRef}`,
            }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
          }
        }
      }
    }

    // Create or update worktree
    // For frozen/pinned mode, use commit-based worktree path to guarantee exact reproducibility
    // This ensures the worktree is at exactly the locked commit, not whatever a branch points to
    const useCommitBasedPath = (frozen || lockedMember?.pinned) && targetCommit !== undefined
    // TypeScript note: when useCommitBasedPath is true, targetCommit is guaranteed to be defined
    const worktreeRef: string = useCommitBasedPath ? targetCommit! : targetRef
    // Use the actual ref type for accurate store path classification
    const worktreeRefType = useCommitBasedPath ? ('commit' as const) : actualRefType
    const worktreePath = store.getWorktreePath({ source, ref: worktreeRef, refType: worktreeRefType })
    const worktreeExists = yield* store.hasWorktree({
      source,
      ref: worktreeRef,
      refType: worktreeRefType,
    })

    if (!worktreeExists && !dryRun) {
      // Ensure worktree parent directory exists
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create worktree
      // Use the actual ref type determined earlier, or check if using commit-based path
      const worktreeRefType = useCommitBasedPath ? 'commit' : actualRefType
      if (worktreeRefType === 'commit' || worktreeRefType === 'tag') {
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
    Effect.catchAll((error) => {
      // Interpret git errors to provide user-friendly messages
      if (error instanceof Git.GitCommandError) {
        const interpreted = Git.interpretGitError(error)
        const message = interpreted.hint
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
