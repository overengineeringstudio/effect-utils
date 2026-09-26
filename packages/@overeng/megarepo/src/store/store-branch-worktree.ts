import * as NodePath from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'

/** Typed refusal when Git's branch registration disagrees with the canonical store path. */
export class StoreBranchWorktreeError extends Schema.TaggedError<StoreBranchWorktreeError>()(
  'StoreBranchWorktreeError',
  {
    reason: Schema.Literals(['GitIdentityConflict', 'CommandFailure', 'IoFailure']),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: StoreBranchWorktreeError['reason']
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new StoreBranchWorktreeError({
    reason,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const normalizePath = (path: string): string => NodePath.resolve(path)

/**
 * Resolve the deepest existing ancestor so path identity matches Git even when the store root is
 * a symlink and the final worktree path does not exist yet.
 */
const canonicalizePath = (path: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const normalized = normalizePath(path)
    const segments = normalized.split(NodePath.sep)
    for (let depth = segments.length; depth > 1; depth -= 1) {
      const existing = segments.slice(0, depth).join(NodePath.sep) || NodePath.sep
      const real = yield* fs.realPath(existing).pipe(Effect.orElseSucceed(() => undefined))
      if (real === undefined) continue
      return normalizePath(NodePath.join(real, ...segments.slice(depth)))
    }
    return normalized
  })

const asDir = (path: string): AbsoluteDirPath =>
  EffectPath.unsafe.absoluteDir(`${path.replace(/\/+$/u, '')}/`)

/**
 * Resolve a store branch worktree to its canonical path `P`.
 *
 * Git's branch registration is authoritative: the branch must be registered exactly at `P`, or
 * not at all while `P` is absent or registered for no branch. Any other registration is refused
 * rather than silently shadowed.
 */
export const resolveStoreBranchWorktree = ({
  bareRepo: rawBareRepo,
  worktreePath: rawWorktreePath,
  branch,
}: {
  readonly bareRepo: string
  readonly worktreePath: string
  readonly branch: string
}): Effect.Effect<
  AbsoluteDirPath,
  StoreBranchWorktreeError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bareRepo = yield* canonicalizePath(rawBareRepo)
    const worktreePath = yield* canonicalizePath(rawWorktreePath)
    const registrations = yield* Git.listWorktrees(bareRepo).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'CommandFailure',
          path: bareRepo,
          message: `Git command failed for '${bareRepo}'`,
          cause,
        }),
      ),
    )
    const atBranch = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === branch,
    )
    if (atBranch.length === 0) {
      let registeredAtPath = 0
      for (const registration of registrations) {
        if ((yield* canonicalizePath(registration.path)) === worktreePath) registeredAtPath += 1
      }
      if (registeredAtPath === 1) return asDir(worktreePath)
      const worktreeExists = yield* fs.exists(asDir(worktreePath)).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'IoFailure',
            path: worktreePath,
            message: `Could not inspect worktree path '${worktreePath}'`,
            cause,
          }),
        ),
      )
      if (registeredAtPath === 0 && worktreeExists === false) return asDir(worktreePath)
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: worktreePath,
        message: `Worktree path '${worktreePath}' exists without an exact Git worktree registration for branch '${branch}'`,
      })
    }
    if (atBranch.length !== 1) {
      return yield* failure({
        reason: 'GitIdentityConflict',
        path: worktreePath,
        message: `Branch '${branch}' has ${atBranch.length} Git worktree registrations`,
      })
    }
    const registration = atBranch[0]!
    if ((yield* canonicalizePath(registration.path)) === worktreePath) return asDir(worktreePath)
    return yield* failure({
      reason: 'GitIdentityConflict',
      path: registration.path,
      message: `Branch '${branch}' is registered outside its canonical store path '${worktreePath}': '${registration.path}'`,
    })
  })
