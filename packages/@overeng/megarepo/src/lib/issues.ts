/**
 * Issue Detection
 *
 * Shared utilities for detecting issues with megarepo members.
 * Used by both sync and status commands.
 */

import { Effect, Option, Schema } from 'effect'

import * as Git from './git.ts'
import { extractRefFromSymlinkPath } from './ref.ts'

// =============================================================================
// RefMismatch Schema (Issue #88)
// =============================================================================

/**
 * Schema for worktree ref mismatch.
 *
 * This occurs when a user runs `git checkout <branch>` or `git checkout <sha>`
 * directly inside a store worktree, causing the git HEAD to differ from the
 * ref implied by the store path.
 *
 * Examples:
 * - Store path: ~/.megarepo/github.com/org/repo/refs/heads/main/
 * - Git HEAD: feature-branch (user ran `git checkout feature-branch`)
 * - Git HEAD: detached at abc123 (user ran `git checkout abc123`)
 *
 * This violates invariant #8: "Worktree path matches HEAD"
 */
export const RefMismatch = Schema.Struct({
  /** The ref implied by the store worktree path (e.g., 'main') */
  expectedRef: Schema.String,
  /**
   * The actual git HEAD state in the worktree.
   * Either a branch name (e.g., 'feature-branch') or short commit SHA if detached.
   */
  actualRef: Schema.String,
  /** True if the worktree is in detached HEAD state */
  isDetached: Schema.Boolean,
})

/** Inferred type for worktree ref mismatch. */
export type RefMismatch = Schema.Schema.Type<typeof RefMismatch>

// =============================================================================
// Detection Functions
// =============================================================================

/**
 * Detect ref mismatch between worktree git HEAD and store path ref.
 *
 * This checks if someone used `git checkout` directly in a store worktree,
 * which would cause the worktree's git HEAD to differ from the ref implied
 * by its store path.
 *
 * Detects two types of mismatches in branch worktrees:
 * 1. User checked out a different branch: `git checkout other-branch`
 * 2. User checked out a commit (detached HEAD): `git checkout abc123`
 *
 * Only applies to branch worktrees - tags and commits are immutable and
 * are expected to be in detached HEAD state.
 *
 * @param worktreePath - Path to the worktree directory
 * @param symlinkTarget - The symlink target path (store worktree path)
 * @returns RefMismatch if mismatch detected, undefined otherwise
 */
export const detectRefMismatch = ({
  worktreePath,
  symlinkTarget,
}: {
  worktreePath: string
  symlinkTarget: string
}) =>
  Effect.gen(function* () {
    // Extract ref info from the symlink target path
    const extracted = extractRefFromSymlinkPath(symlinkTarget)
    if (extracted === undefined) return undefined

    // Only check for branches - tags and commits are immutable
    // (they're expected to be in detached HEAD state)
    if (extracted.type !== 'branch') return undefined

    const expectedRef = extracted.ref

    // Get the actual git branch from the worktree
    const actualBranchOpt = yield* Git.getCurrentBranch(worktreePath).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none<string>())),
    )

    // If detached HEAD in a branch worktree, that's a mismatch
    // (user ran `git checkout <sha>` in a branch-based worktree)
    if (Option.isNone(actualBranchOpt) === true) {
      // Get the short commit SHA for display
      const commitSha = yield* Git.getCurrentCommit(worktreePath).pipe(
        Effect.map((sha) => sha.slice(0, 7)),
        Effect.catchAll(() => Effect.succeed('unknown')),
      )

      return {
        expectedRef,
        actualRef: commitSha,
        isDetached: true,
      } satisfies RefMismatch
    }

    const actualRef = actualBranchOpt.value

    // If they match, no mismatch
    if (actualRef === expectedRef) return undefined

    return {
      expectedRef,
      actualRef,
      isDetached: false,
    } satisfies RefMismatch
  })

/**
 * Format a ref mismatch into a human-readable message with hint.
 */
export const formatRefMismatchMessage = ({
  refMismatch,
  memberName,
}: {
  refMismatch: RefMismatch
  memberName: string
}): string => {
  if (refMismatch.isDetached) {
    // Detached HEAD case
    const lines = [
      `ref mismatch: store path implies '${refMismatch.expectedRef}' but worktree is detached at ${refMismatch.actualRef}`,
      `  hint: use 'mr pin ${memberName} -c ${refMismatch.actualRef}' to pin this commit,`,
      `        or 'git checkout ${refMismatch.expectedRef}' to restore expected state`,
    ]
    return lines.join('\n')
  }

  // Different branch case
  const lines = [
    `ref mismatch: store path implies '${refMismatch.expectedRef}' but worktree HEAD is '${refMismatch.actualRef}'`,
    `  hint: use 'mr pin ${memberName} -c ${refMismatch.actualRef}' to create proper worktree,`,
    `        or 'git checkout ${refMismatch.expectedRef}' to restore expected state`,
  ]
  return lines.join('\n')
}
