/**
 * Lossless floor for cold named-branch worktrees (decisions 0001/0003/0004).
 *
 * A `refs/heads/*` worktree may only be archived/reaped when removing its
 * directory loses NO recoverable work. That floor has three independent parts,
 * each computed here:
 *
 * 1. {@link unpushedCommitCount} — commits reachable from the worktree HEAD that
 *    are on NO remote-tracking ref. This is `git -C <bare> rev-list <head>
 *    --not --remotes` (decision 0003), NOT `branch -r --contains`: the worktree
 *    head can be a fresh local commit stacked on a parent that lives on an
 *    unrelated remote ref (the "B1" case). `--not --remotes` walks down and stops
 *    at the first remote-reachable ancestor, so it reports exactly the
 *    genuinely-unpushed commits (1 in that case), whereas a "is this tip on a
 *    remote" check would wrongly call it pushed. `> 0` ⇒ keep.
 * 2. {@link hasStash} — presence of the repo-global `refs/stash`. Stash refs live
 *    in the bare and do NOT travel with a worktree directory move (invariant 2c),
 *    so a non-empty stash means a dir move would orphan stashed work. Present ⇒
 *    keep.
 * 3. dirt — uncommitted/untracked changes via {@link Git.getWorktreeStatus}.
 *    Dirt itself travels intact with `git worktree move`, so it does NOT block
 *    archival on its own; it is surfaced so the classifier/archiver can record
 *    and preserve it.
 *
 * Freshness contract: {@link unpushedCommitCount} only reflects what
 * `refs/remotes/*` knows, so the caller MUST {@link Git.fetchBare} (fetch
 * --prune) the repo first; on a repo whose fetch failed, every commit reads as
 * unpushed and the worktree is kept — the conservative direction.
 */

import { Effect } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from './git.ts'

/**
 * The three lossless signals for one named-branch worktree, in the exact shape
 * the cold classifier (`classifyColdWorktree`) consumes.
 */
export interface LosslessAssessment {
  /** Commits on no remote-tracking ref. `> 0` ⇒ unrecoverable local work ⇒ keep. */
  readonly unpushed: number
  /** Uncommitted/untracked changes present (travels with a dir move). */
  readonly dirty: boolean
  /** A repo-global stash exists. Present ⇒ keep (does not travel with a dir move). */
  readonly hasStash: boolean
}

/**
 * Count commits reachable from `worktreeHead` that are on NO remote-tracking ref.
 *
 * `0` ⇒ every commit is recoverable from a remote (pushed, possibly via an
 * unrelated remote branch). Requires fresh `refs/remotes/*` (caller fetches
 * --prune first). A `GitCommandError` (e.g. an unresolvable head) is propagated
 * so the caller can degrade to keep.
 */
export const unpushedCommitCount = (args: {
  bareRepoPath: AbsoluteDirPath
  worktreeHead: string
}) =>
  Git.revListUnpushed({ repoPath: args.bareRepoPath, ref: args.worktreeHead }).pipe(
    Effect.map((commits) => commits.length),
    Effect.withSpan('megarepo/store/gc/unpushed-commit-count', {
      attributes: { 'span.label': args.worktreeHead.slice(0, 8), worktreeHead: args.worktreeHead },
    }),
  )

/**
 * Whether the bare repo has a non-empty stash.
 *
 * Stashes are repo-global (`refs/stash`), not per-worktree, so this is a
 * bare-scoped check. Never fails: a missing ref reads as `false`.
 */
export const hasStash = (args: { bareRepoPath: AbsoluteDirPath }) =>
  Git.hasStashRef({ repoPath: args.bareRepoPath })

/**
 * Compute the full {@link LosslessAssessment} for one named-branch worktree.
 *
 * `unpushed` may fail with `GitCommandError` (propagated for conservative
 * degradation upstream); `dirty` and `hasStash` are infallible. Assumes the
 * repo's `refs/remotes/*` are already fresh (caller fetched --prune).
 */
export const assessLossless = (args: {
  bareRepoPath: AbsoluteDirPath
  worktreePath: AbsoluteDirPath
  worktreeHead: string
}) =>
  Effect.gen(function* () {
    const unpushed = yield* unpushedCommitCount({
      bareRepoPath: args.bareRepoPath,
      worktreeHead: args.worktreeHead,
    })
    const status = yield* Git.getWorktreeStatus(args.worktreePath)
    const stash = yield* hasStash({ bareRepoPath: args.bareRepoPath })

    return {
      unpushed,
      dirty: status.isDirty,
      hasStash: stash,
    } satisfies LosslessAssessment
  }).pipe(
    Effect.withSpan('megarepo/store/gc/assess-lossless', {
      attributes: { 'span.label': 'lossless', worktreePath: args.worktreePath },
    }),
  )
