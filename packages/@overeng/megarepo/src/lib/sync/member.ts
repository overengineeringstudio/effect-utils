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
  semaphoreMap,
  gitProtocol = 'auto',
  createBranches = false,
  commitMode,
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
  /** When true, use commit-based worktrees (refs/commits/<sha>) for deterministic apply */
  commitMode?: boolean
  /** Callback when a ref doesn't exist. If not provided, defaults to 'error' behavior. */
  onMissingRef?: (info: MissingRefInfo) => Effect.Effect<MissingRefAction, never, R>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store
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
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const memberExists = currentLink !== null

    // In lock and apply modes, if member exists, check if symlink points to correct ref
    if (memberExists === true && (isLockMode === true || isApplyMode === true)) {
      const currentLinkNormalized = currentLink?.replace(/\/$/, '')

      if (isLockMode === true) {
        // Lock mode: check symlink against the expected branch worktree path
        const expectedWorktreePath = store.getWorktreePath({ source, ref: targetRef })
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
          Effect.catchAll(() => Effect.succeed(Option.none<string>())),
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

      // Apply mode: check for ref mismatch on the current symlink target (if it's a branch worktree).
      // Content-aware selection happens later, but ref mismatch detection should still warn the user.
      if (currentLinkNormalized !== undefined) {
        const extracted = extractRefFromSymlinkPath(currentLinkNormalized)
        if (extracted?.type === 'branch') {
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
        }
      }

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
      // Fall through to content-aware worktree selection
    }

    // For lock update mode, check if worktree is dirty before making changes
    if (isApplyMode === true && memberExists === true && dryRun === false) {
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
          const createBareRepo = Effect.gen(function* () {
            // Check again inside semaphore (double-check locking pattern)
            const stillNotExists = (yield* store.hasBareRepo(source)) === false
            if (stillNotExists === true) {
              const repoBasePath = store.getRepoBasePath(source)
              yield* fs.makeDirectory(repoBasePath, { recursive: true })
              yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
              yield* Effect.annotateCurrentSpan('action', 'clone')
              return true
            }
            yield* Effect.annotateCurrentSpan('action', 'already-cloned-by-sibling')
            return false
          })

          if (semaphoreMap !== undefined) {
            const sem = yield* getRepoSemaphore({ semaphoreMapRef: semaphoreMap, url: cloneUrl })
            return yield* sem.withPermits(1)(createBareRepo)
          }
          return yield* createBareRepo
        }
        yield* Effect.annotateCurrentSpan('action', 'skip-dry-run')
      } else if (isFetchMode === true && dryRun === false) {
        yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))
        yield* Effect.annotateCurrentSpan('action', 'fetch')
      } else if (isApplyMode === true && targetCommit !== undefined && dryRun === false) {
        const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
        if (commitExists === false) {
          yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))
          yield* Effect.annotateCurrentSpan('action', 'fetch-missing-commit')
        } else {
          yield* Effect.annotateCurrentSpan('action', 'noop')
        }
      } else {
        yield* Effect.annotateCurrentSpan('action', 'noop')
      }
      return false
    }).pipe(
      Effect.withSpan('megarepo/sync/member/clone-or-fetch', {
        attributes: { 'span.label': name, bareExists },
      }),
    )

    /**
     * A lock entry can point at an object that disappeared after a force-push.
     * In lock update mode we can recover branch-based members by re-resolving `targetRef`,
     * but pinned commit-SHA refs remain hard failures because there is no mutable ref to follow.
     */
    if (dryRun === false && targetCommit !== undefined) {
      const commitExists = yield* Git.refExists({ repoPath: bareRepoPath, ref: targetCommit })
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
            }).pipe(
              Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
            )
          } else if (refInfo.type === 'branch') {
            resolvedRefType = 'branch'
            resolvedCommit = yield* Git.resolveRef({
              repoPath: bareRepoPath,
              ref: `refs/remotes/origin/${targetRef}`,
            }).pipe(
              Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
            )
          } else {
            const heuristicType = classifyRef(targetRef)
            resolvedRefType = heuristicType
            if (heuristicType === 'tag') {
              resolvedCommit = yield* Git.resolveRef({
                repoPath: bareRepoPath,
                ref: `refs/tags/${targetRef}`,
              }).pipe(
                Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
              )
            } else {
              resolvedCommit = yield* Git.resolveRef({
                repoPath: bareRepoPath,
                ref: `refs/remotes/origin/${targetRef}`,
              }).pipe(
                Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })),
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
    }).pipe(
      Effect.withSpan('megarepo/sync/member/resolve-ref', {
        attributes: { 'span.label': targetRef, ref: targetRef },
      }),
    )

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

    // Worktree mode selection in apply mode:
    // - commit mode (--worktree-mode=commit, CI default): refs/commits/<sha>/ — deterministic
    // - tracking mode (default): refs/heads/<branch>/ — dev convenience, with checkout fallback
    const useCommitWorktree =
      isApplyMode === true &&
      commitMode === true &&
      targetCommit !== undefined &&
      actualRefType === 'branch'
    // targetCommit is guaranteed non-undefined when useCommitWorktree is true (guarded above)
    const worktreeRef: string = useCommitWorktree === true ? targetCommit! : targetRef
    const worktreeRefType: RefType = useCommitWorktree === true ? 'commit' : actualRefType

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
      yield* Effect.gen(function* () {
        // Ensure worktree parent directory exists
        const worktreeParent = EffectPath.ops.parent(worktreePath)
        if (worktreeParent !== undefined) {
          yield* fs.makeDirectory(worktreeParent, { recursive: true })
        }

        // Create worktree
        if (worktreeRefType === 'commit' || worktreeRefType === 'tag') {
          yield* Git.createWorktreeDetached({
            repoPath: bareRepoPath,
            worktreePath,
            commit: targetCommit ?? worktreeRef,
          })
        } else {
          yield* Git.createWorktree({
            repoPath: bareRepoPath,
            worktreePath,
            branch: targetRef,
            createBranch: false,
          }).pipe(
            Effect.catchAll(() =>
              Git.createWorktree({
                repoPath: bareRepoPath,
                worktreePath,
                branch: `origin/${targetRef}`,
                createBranch: false,
              }),
            ),
          )
        }
      }).pipe(
        // Handle race condition: when multiple nested megarepos reference
        // the same member, concurrent syncs may both pass the hasWorktree
        // check but the second git worktree add fails. Re-check existence
        // and succeed if the worktree was created by the concurrent sync.
        Effect.catchIf(
          (error) =>
            error instanceof Git.GitCommandError &&
            error.stderr.includes('already exists and is not an empty directory'),
          () =>
            store.hasWorktree({ source, ref: worktreeRef, refType: worktreeRefType }).pipe(
              Effect.flatMap((exists) =>
                exists === true
                  ? Effect.void
                  : Effect.fail(
                      new Git.GitCommandError({
                        args: ['worktree', 'add'],
                        exitCode: 1,
                        stderr: 'Target directory already exists but is not a valid worktree',
                      }),
                    ),
              ),
            ),
        ),
        Effect.withSpan('megarepo/sync/member/create-worktree', {
          attributes: { 'span.label': worktreeRef, ref: worktreeRef, refType: worktreeRefType },
        }),
      )
    }

    // In tracking mode (branch worktrees), ensure the worktree is at the locked commit.
    // Try ff-merge first; if the branch has advanced past the locked commit, fall back to
    // git checkout (detached HEAD with correct content).
    let remoteUpdated = false
    let remotePreviousCommit: string | undefined
    if (
      isApplyMode === true &&
      dryRun === false &&
      worktreeRefType === 'branch' &&
      targetCommit !== undefined
    ) {
      // Check for ref mismatch before merging — if someone ran `git checkout <other-branch>`
      // in the worktree, we must not merge into the wrong branch.
      const worktreeBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      const onExpectedBranch =
        Option.isSome(worktreeBranch) === true && worktreeBranch.value === targetRef

      if (onExpectedBranch === true) {
        const currentCommitOpt = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
        const currentCommit = Option.getOrUndefined(currentCommitOpt)
        if (currentCommit !== undefined && currentCommit !== targetCommit) {
          yield* Git.mergeFFOnly({ worktreePath, ref: targetCommit }).pipe(
            Effect.catchAll(() =>
              // FF-merge failed (branch ahead of locked commit) — detach HEAD at correct commit
              Git.checkoutWorktree({ worktreePath, ref: targetCommit }),
            ),
          )
          const headAfterMerge = yield* Git.getCurrentCommit(worktreePath)
          if (headAfterMerge !== currentCommit) {
            remotePreviousCommit = currentCommit
            remoteUpdated = true
          }
        }
      } else {
        // Ref mismatch: worktree is on a different branch — report as error
        const refMismatch = yield* detectRefMismatch({
          worktreePath,
          symlinkTarget: worktreePath.replace(/\/$/, ''),
        })
        if (refMismatch !== undefined) {
          return {
            name,
            status: 'skipped',
            message: formatRefMismatchMessage({ refMismatch, memberName: name }),
            refMismatch,
          } satisfies MemberSyncResult
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
          status: remoteUpdated === true ? 'updated' : 'already_synced',
          commit: targetCommit,
          previousCommit: remotePreviousCommit,
          ref: targetRef,
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
    Effect.tap((result) => Effect.annotateCurrentSpan('result.status', result.status)),
    Effect.catchAll((error) => {
      // Interpret git errors to provide user-friendly messages
      if (error instanceof Git.GitCommandError) {
        const interpreted = Git.interpretGitError(error)
        const message =
          interpreted.hint !== undefined
            ? `${interpreted.message}\n  hint: ${interpreted.hint}`
            : interpreted.message
        return Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan('result.status', 'error')
          return {
            name,
            status: 'error',
            message,
          } satisfies MemberSyncResult
        })
      }
      return Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan('result.status', 'error')
        return {
          name,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        } satisfies MemberSyncResult
      })
    }),
    Effect.withSpan('megarepo/sync/member', {
      attributes: { 'span.label': name, name, source: sourceString },
    }),
  )
