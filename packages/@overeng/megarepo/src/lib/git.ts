/**
 * Git operations for megarepo
 *
 * Provides Effect-wrapped git operations for cloning, fetching, and managing worktrees.
 */

import { Command, CommandExecutor } from '@effect/platform'
import { Effect, Option, Scope } from 'effect'

// =============================================================================
// Git URL Parsing
// =============================================================================

export interface ParsedGitRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
}

/**
 * Parse a git remote URL (SSH or HTTPS) into host/owner/repo components
 */
export const parseGitRemoteUrl = (url: string): Option.Option<ParsedGitRemote> => {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined && sshMatch[3] !== undefined) {
    return Option.some({
      host: sshMatch[1],
      owner: sshMatch[2],
      repo: sshMatch[3],
    })
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined && httpsMatch[3] !== undefined) {
    return Option.some({
      host: httpsMatch[1],
      owner: httpsMatch[2],
      repo: httpsMatch[3],
    })
  }

  return Option.none()
}

// =============================================================================
// Git Commands
// =============================================================================

const runGitCommand = (args: ReadonlyArray<string>, options?: { cwd?: string }) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const cmd = Command.make('git', ...args).pipe(
      options?.cwd ? Command.workingDirectory(options.cwd) : (x) => x,
    )

    const result = yield* executor.string(cmd)
    return result.trim()
  })

/**
 * Clone a git repository
 */
export const clone = (args: { url: string; targetPath: string; bare?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['clone']
    if (args.bare) {
      cmdArgs.push('--bare')
    }
    cmdArgs.push(args.url, args.targetPath)
    yield* runGitCommand(cmdArgs)
  })

/**
 * Fetch updates from remote
 */
export const fetch = (args: { repoPath: string; remote?: string; prune?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['fetch']
    if (args.prune) {
      cmdArgs.push('--prune')
    }
    cmdArgs.push(args.remote ?? 'origin')
    yield* runGitCommand(cmdArgs, { cwd: args.repoPath })
  })

/**
 * Checkout a specific ref (branch, tag, or commit)
 */
export const checkout = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    yield* runGitCommand(['checkout', args.ref], { cwd: args.repoPath })
  })

/**
 * Get the current branch name
 */
export const getCurrentBranch = (repoPath: string) =>
  Effect.gen(function* () {
    const result = yield* runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
    return result === 'HEAD' ? Option.none() : Option.some(result)
  })

/**
 * Get the current commit SHA
 */
export const getCurrentCommit = (repoPath: string) =>
  Effect.gen(function* () {
    return yield* runGitCommand(['rev-parse', 'HEAD'], { cwd: repoPath })
  })

/**
 * Get the remote URL (origin by default)
 */
export const getRemoteUrl = (repoPath: string, remote = 'origin') =>
  Effect.gen(function* () {
    return yield* runGitCommand(['remote', 'get-url', remote], { cwd: repoPath }).pipe(
      Effect.map(Option.some),
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
  })

/**
 * Check if a directory is a git repository
 */
export const isGitRepo = (path: string) =>
  Effect.gen(function* () {
    return yield* runGitCommand(['rev-parse', '--git-dir'], { cwd: path }).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    )
  })

// =============================================================================
// Git Worktree Operations
// =============================================================================

/**
 * Create a git worktree
 */
export const createWorktree = (args: {
  repoPath: string
  worktreePath: string
  branch: string
  createBranch?: boolean
}) =>
  Effect.gen(function* () {
    const cmdArgs = ['worktree', 'add']
    if (args.createBranch) {
      cmdArgs.push('-b', args.branch)
      cmdArgs.push(args.worktreePath)
    } else {
      cmdArgs.push(args.worktreePath, args.branch)
    }
    yield* runGitCommand(cmdArgs, { cwd: args.repoPath })
  })

/**
 * Remove a git worktree
 */
export const removeWorktree = (args: { repoPath: string; worktreePath: string; force?: boolean }) =>
  Effect.gen(function* () {
    const cmdArgs = ['worktree', 'remove']
    if (args.force) {
      cmdArgs.push('--force')
    }
    cmdArgs.push(args.worktreePath)
    yield* runGitCommand(cmdArgs, { cwd: args.repoPath })
  })

/**
 * List git worktrees
 */
export const listWorktrees = (repoPath: string) =>
  Effect.gen(function* () {
    const output = yield* runGitCommand(['worktree', 'list', '--porcelain'], { cwd: repoPath })
    const worktrees: Array<{ path: string; head: string; branch: Option.Option<string> }> = []

    let current: { path?: string; head?: string; branch?: string } = {}
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        current.path = line.slice(9)
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === '') {
        if (current.path && current.head) {
          worktrees.push({
            path: current.path,
            head: current.head,
            branch: Option.fromNullable(current.branch),
          })
        }
        current = {}
      }
    }

    return worktrees
  })

// =============================================================================
// Megarepo Name Derivation
// =============================================================================

/**
 * Derive megarepo name from git remote or directory name
 */
export const deriveMegarepoName = (repoPath: string) =>
  Effect.gen(function* () {
    // Try to get name from git remote
    const remoteUrl = yield* getRemoteUrl(repoPath)

    return Option.flatMap(remoteUrl, parseGitRemoteUrl).pipe(
      Option.map((parsed) => `${parsed.owner}/${parsed.repo}`),
      Option.getOrElse(() => {
        // Fall back to directory name
        const parts = repoPath.split('/')
        return parts[parts.length - 1] ?? 'unknown'
      }),
    )
  })
