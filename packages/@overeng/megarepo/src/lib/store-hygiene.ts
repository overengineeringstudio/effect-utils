/**
 * Store Hygiene Validation
 *
 * Reusable validation functions that check store consistency.
 * Used by pre-flight checks (sync/lock/pin) and `mr store fix`.
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import type { CommandExecutor } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import {
  type MegarepoConfig,
  type MemberSource,
  isRemoteSource,
  parseSourceString,
  getSourceRef,
} from './config.ts'
import * as Git from './git.ts'
import type { LockFile } from './lock.ts'
import type { MegarepoStore } from './store.ts'

// =============================================================================
// Store Issue Types
// =============================================================================

export type StoreIssueSeverity = 'error' | 'warning' | 'info'

export type StoreIssueType =
  | 'ref_mismatch'
  | 'broken_worktree'
  | 'missing_bare'
  | 'dirty'
  | 'unpushed'
  | 'orphaned'

export interface StoreIssue {
  readonly severity: StoreIssueSeverity
  readonly type: StoreIssueType
  readonly memberName: string
  readonly message: string
  /** Human-readable fix instructions */
  readonly fix?: string | undefined
  /** Extra data for programmatic fixes */
  readonly meta?: StoreIssueMeta | undefined
}

export type StoreIssueMeta =
  | { readonly _tag: 'ref_mismatch'; readonly expectedRef: string; readonly actualRef: string; readonly worktreePath: string }
  | { readonly _tag: 'broken_worktree'; readonly worktreePath: string; readonly source: MemberSource }
  | { readonly _tag: 'missing_bare'; readonly source: MemberSource }

// =============================================================================
// Store Hygiene Error
// =============================================================================

export class StoreHygieneError extends Schema.TaggedError<StoreHygieneError>()(
  'StoreHygieneError',
  {
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        severity: Schema.Literal('error', 'warning', 'info'),
        type: Schema.String,
        memberName: Schema.String,
        message: Schema.String,
        fix: Schema.optional(Schema.String),
      }),
    ),
  },
) {}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate store consistency for the given members.
 *
 * Checks:
 * - `ref_mismatch` (error): worktree HEAD branch doesn't match expected ref
 * - `broken_worktree` (error): .git file in worktree is broken or missing
 * - `missing_bare` (error): bare repo doesn't exist but is expected
 * - `dirty` (warning): worktree has uncommitted changes
 * - `unpushed` (warning): worktree has unpushed commits
 */
export const validateStoreMembers = ({
  memberNames,
  config,
  lockFile,
  store,
}: {
  memberNames: readonly string[]
  config: MegarepoConfig
  lockFile: LockFile
  store: MegarepoStore
}): Effect.Effect<
  StoreIssue[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const issues: StoreIssue[] = []

    for (const memberName of memberNames) {
      const sourceString = config.members[memberName]
      if (sourceString === undefined) continue

      const source = parseSourceString(sourceString)
      if (source === undefined || isRemoteSource(source) === false) continue

      const lockedMember = lockFile.members[memberName]
      if (lockedMember === undefined) continue

      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* fs.exists(bareRepoPath)

      if (bareExists === false) {
        issues.push({
          severity: 'error',
          type: 'missing_bare',
          memberName,
          message: `bare repo not found at ${bareRepoPath}`,
          fix: `run 'mr apply' to clone the bare repo`,
          meta: { _tag: 'missing_bare', source },
        })
        continue
      }

      const worktreePath = store.getWorktreePath({
        source,
        ref: lockedMember.ref,
      })

      const gitFilePath = `${worktreePath}.git`.replace(/\/\.git$/, '/.git')
      const gitFileExists = yield* fs.exists(gitFilePath).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      )

      if (gitFileExists === false) {
        issues.push({
          severity: 'error',
          type: 'broken_worktree',
          memberName,
          message: `.git not found in worktree at ${worktreePath}`,
          fix: `run 'mr apply' to recreate the worktree`,
          meta: { _tag: 'broken_worktree', worktreePath, source },
        })
        continue
      }

      // Check ref mismatch (only for branch worktrees)
      const sourceRef = Option.getOrElse(getSourceRef(source), () => 'main')
      const expectedRef = lockedMember.ref

      // Only check branch-type refs for mismatch (tags/commits are detached by design)
      if (/^[0-9a-f]{40}$/i.test(expectedRef) === false) {
        const actualBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
          Effect.catchAll(() => Effect.succeed(Option.none<string>())),
        )

        if (Option.isSome(actualBranch) && actualBranch.value !== expectedRef) {
          issues.push({
            severity: 'error',
            type: 'ref_mismatch',
            memberName,
            message: `worktree HEAD is '${actualBranch.value}' but expected '${expectedRef}'`,
            fix: `run 'git -C ${worktreePath} checkout ${expectedRef}' or 'mr store fix'`,
            meta: {
              _tag: 'ref_mismatch',
              expectedRef,
              actualRef: actualBranch.value,
              worktreePath,
            },
          })
        } else if (Option.isNone(actualBranch)) {
          // Detached HEAD in a branch worktree is also a mismatch
          const commitSha = yield* Git.getCurrentCommit(worktreePath).pipe(
            Effect.map((sha) => sha.slice(0, 7)),
            Effect.catchAll(() => Effect.succeed('unknown')),
          )
          issues.push({
            severity: 'error',
            type: 'ref_mismatch',
            memberName,
            message: `worktree is detached at ${commitSha} but expected branch '${expectedRef}'`,
            fix: `run 'git -C ${worktreePath} checkout ${expectedRef}' or 'mr store fix'`,
            meta: {
              _tag: 'ref_mismatch',
              expectedRef,
              actualRef: commitSha,
              worktreePath,
            },
          })
        }
      }

      // Check dirty/unpushed (warnings)
      const worktreeStatus = yield* Git.getWorktreeStatus(worktreePath).pipe(
        Effect.catchAll(() =>
          Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 }),
        ),
      )

      if (worktreeStatus.isDirty) {
        issues.push({
          severity: 'warning',
          type: 'dirty',
          memberName,
          message: `${worktreeStatus.changesCount} uncommitted change${worktreeStatus.changesCount !== 1 ? 's' : ''}`,
        })
      }

      if (worktreeStatus.hasUnpushed) {
        issues.push({
          severity: 'warning',
          type: 'unpushed',
          memberName,
          message: 'has unpushed commits',
        })
      }
    }

    return issues
  })

// =============================================================================
// Pre-flight Checks
// =============================================================================

/**
 * Run pre-flight hygiene checks before write operations.
 *
 * - Error-severity issues: fail with actionable error message
 * - Warning-severity: log warning, proceed
 * - Info-severity: silent
 */
export const runPreflightChecks = ({
  memberNames,
  config,
  lockFile,
  store,
  strict = true,
}: {
  memberNames: readonly string[]
  config: MegarepoConfig
  lockFile: LockFile
  store: MegarepoStore
  strict?: boolean | undefined
}): Effect.Effect<
  void,
  StoreHygieneError | PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const issues = yield* validateStoreMembers({
      memberNames,
      config,
      lockFile,
      store,
    })

    if (issues.length === 0) return

    const errors = issues.filter((i) => i.severity === 'error')
    const warnings = issues.filter((i) => i.severity === 'warning')

    // Log warnings
    for (const warning of warnings) {
      yield* Effect.logWarning(`[${warning.memberName}] ${warning.message}`)
    }

    // Fail on errors (unless non-strict mode)
    if (strict && errors.length > 0) {
      const errorMessages = errors
        .map((e) => {
          const fixHint = e.fix !== undefined ? `\n  fix: ${e.fix}` : ''
          return `  ${e.memberName}: ${e.message}${fixHint}`
        })
        .join('\n')

      return yield* new StoreHygieneError({
        message: `Store hygiene check failed with ${errors.length} error${errors.length !== 1 ? 's' : ''}:\n${errorMessages}`,
        issues: issues.map((i) => ({
          severity: i.severity,
          type: i.type,
          memberName: i.memberName,
          message: i.message,
          fix: i.fix,
        })),
      })
    }
  })

// =============================================================================
// Fix Operations
// =============================================================================

export interface FixResult {
  readonly memberName: string
  readonly issueType: StoreIssueType
  readonly status: 'fixed' | 'skipped' | 'error'
  readonly message: string
}

/**
 * Attempt to fix store issues.
 *
 * Currently supports:
 * - `ref_mismatch`: checkout the expected branch in the worktree
 * - `broken_worktree`: remove and recreate the worktree
 * - `missing_bare`: clone the bare repo
 */
export const fixStoreIssues = ({
  issues,
  store,
  dryRun = false,
}: {
  issues: readonly StoreIssue[]
  store: MegarepoStore
  dryRun?: boolean | undefined
}): Effect.Effect<
  FixResult[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const results: FixResult[] = []

    for (const issue of issues) {
      // Only attempt to fix error-severity issues
      if (issue.severity !== 'error') continue

      switch (issue.type) {
        case 'ref_mismatch': {
          if (issue.meta?._tag !== 'ref_mismatch') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { expectedRef, worktreePath } = issue.meta

          if (dryRun) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would checkout '${expectedRef}' in ${worktreePath}`,
            })
            break
          }

          yield* Git.checkout({ repoPath: worktreePath, ref: expectedRef }).pipe(
            Effect.match({
              onSuccess: () => {
                results.push({
                  memberName: issue.memberName,
                  issueType: issue.type,
                  status: 'fixed',
                  message: `checked out '${expectedRef}'`,
                })
              },
              onFailure: (err) => {
                results.push({
                  memberName: issue.memberName,
                  issueType: issue.type,
                  status: 'error',
                  message: `failed to checkout '${expectedRef}': ${err instanceof Error ? err.message : String(err)}`,
                })
              },
            }),
          )
          break
        }

        case 'broken_worktree': {
          if (issue.meta?._tag !== 'broken_worktree') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { worktreePath, source } = issue.meta
          const bareRepoPath = store.getBareRepoPath(source)

          if (dryRun) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would recreate worktree at ${worktreePath}`,
            })
            break
          }

          // Remove existing broken worktree
          yield* fs.remove(worktreePath, { recursive: true }).pipe(
            Effect.catchAll(() => Effect.void),
          )

          // Recreate the worktree
          yield* Effect.gen(function* () {
            yield* fs.makeDirectory(worktreePath, { recursive: true }).pipe(
              Effect.catchAll(() => Effect.void),
            )

            // Extract ref from the worktree path
            const pathParts = worktreePath.split('/refs/heads/')
            const ref = pathParts[1]?.replace(/\/$/, '')

            if (ref !== undefined) {
              yield* Git.createWorktree({
                repoPath: bareRepoPath,
                worktreePath,
                branch: ref,
                createBranch: false,
              }).pipe(
                Effect.catchAll(() =>
                  Git.createWorktreeDetached({
                    repoPath: bareRepoPath,
                    worktreePath,
                    commit: ref,
                  }),
                ),
              )
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'fixed',
                message: `recreated worktree for '${ref}'`,
              })
            } else {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: 'could not determine ref from worktree path',
              })
            }
          }).pipe(
            Effect.catchAll((err) => {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: `failed to recreate worktree: ${err instanceof Error ? err.message : String(err)}`,
              })
              return Effect.void
            }),
          )
          break
        }

        case 'missing_bare': {
          if (issue.meta?._tag !== 'missing_bare') {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: 'missing metadata for fix',
            })
            break
          }

          const { source } = issue.meta
          const bareRepoPath = store.getBareRepoPath(source)

          if (dryRun) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'skipped',
              message: `would clone bare repo to ${bareRepoPath}`,
            })
            break
          }

          // Determine clone URL
          let cloneUrl: string | undefined
          if (source.type === 'github') {
            cloneUrl = `git@github.com:${source.owner}/${source.repo}.git`
          } else if (source.type === 'url') {
            cloneUrl = source.url
          }

          if (cloneUrl === undefined) {
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'error',
              message: 'cannot determine clone URL',
            })
            break
          }

          yield* Effect.gen(function* () {
            const repoBasePath = store.getRepoBasePath(source)
            yield* fs.makeDirectory(repoBasePath, { recursive: true })
            yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
            results.push({
              memberName: issue.memberName,
              issueType: issue.type,
              status: 'fixed',
              message: `cloned bare repo from ${cloneUrl}`,
            })
          }).pipe(
            Effect.catchAll((err) => {
              results.push({
                memberName: issue.memberName,
                issueType: issue.type,
                status: 'error',
                message: `failed to clone: ${err instanceof Error ? err.message : String(err)}`,
              })
              return Effect.void
            }),
          )
          break
        }

        default: {
          results.push({
            memberName: issue.memberName,
            issueType: issue.type,
            status: 'skipped',
            message: `no automatic fix for '${issue.type}'`,
          })
        }
      }
    }

    return results
  })
