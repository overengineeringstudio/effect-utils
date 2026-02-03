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
 * This occurs when a user runs `git checkout <branch>` directly inside a store
 * worktree, causing the git HEAD to differ from the ref implied by the store path.
 *
 * Example:
 * - Store path: ~/.megarepo/github.com/org/repo/refs/heads/main/
 * - Git HEAD: feature-branch (user ran `git checkout feature-branch`)
 *
 * This violates invariant #8: "Worktree path matches HEAD"
 */
export const RefMismatch = Schema.Struct({
  /** The ref implied by the store worktree path (e.g., 'main') */
  expectedRef: Schema.String,
  /** The actual git HEAD branch in the worktree (e.g., 'feature-branch') */
  actualRef: Schema.String,
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
 * Only applies to branch worktrees - tags and commits are immutable and
 * checked out in detached HEAD state.
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
    // (they're in detached HEAD state, so comparison doesn't apply)
    if (extracted.type !== 'branch') return undefined

    const expectedRef = extracted.ref

    // Get the actual git branch from the worktree
    const actualBranchOpt = yield* Git.getCurrentBranch(worktreePath).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none<string>())),
    )

    // If we can't get the branch (detached HEAD or error), no mismatch to report
    if (Option.isNone(actualBranchOpt)) return undefined

    const actualRef = actualBranchOpt.value

    // If they match, no mismatch
    if (actualRef === expectedRef) return undefined

    return {
      expectedRef,
      actualRef,
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
  const lines = [
    `ref mismatch: store path implies '${refMismatch.expectedRef}' but worktree HEAD is '${refMismatch.actualRef}'`,
    `  hint: use 'mr pin ${memberName} -c ${refMismatch.actualRef}' to create proper worktree,`,
    `        or 'git checkout ${refMismatch.expectedRef}' to restore expected state`,
  ]
  return lines.join('\n')
}
