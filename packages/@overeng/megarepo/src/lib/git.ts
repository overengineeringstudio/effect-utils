/**
 * Git operations for megarepo
 *
 * Provides Effect-wrapped git operations for cloning, fetching, and managing worktrees.
 */

import { Command } from '@effect/platform'
import { Chunk, Effect, Option, Stream } from 'effect'

// =============================================================================
// Git URL Parsing
// =============================================================================

/** Parsed components of a git remote URL */
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
// Git Command Error
// =============================================================================

/** Error thrown when a git command fails with non-zero exit code */
export class GitCommandError extends Error {
  readonly _tag = 'GitCommandError'
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string

  constructor({
    args,
    exitCode,
    stderr,
  }: {
    args: ReadonlyArray<string>
    exitCode: number
    stderr: string
  }) {
    // Use stderr as the message if available, otherwise use a generic message
    const stderrTrimmed = stderr.trim()
    const message =
      stderrTrimmed.length > 0
        ? stderrTrimmed
        : `git ${args.join(' ')} failed with exit code ${exitCode}`
    super(message)
    this.name = 'GitCommandError'
    this.args = args
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

// =============================================================================
// Git Commands
// =============================================================================

/**
 * Run a git command and return stdout.
 * Fails with GitCommandError if exit code is non-zero.
 */
const runGitCommand = ({ args, cwd }: { args: ReadonlyArray<string>; cwd?: string }) =>
  Effect.gen(function* () {
    const cmd = Command.make('git', ...args).pipe(
      cwd ? Command.workingDirectory(cwd) : (x) => x,
      Command.stderr('pipe'),
      Command.stdout('pipe'),
    )

    const process = yield* Command.start(cmd)

    // Collect stdout and stderr
    const decoder = new TextDecoder('utf-8')
    const [stdoutChunks, stderrChunks] = yield* Effect.all([
      Stream.runCollect(process.stdout),
      Stream.runCollect(process.stderr),
    ])

    const stdout = decoder.decode(
      Chunk.toReadonlyArray(stdoutChunks).reduce((acc, chunk) => {
        const result = new Uint8Array(acc.length + chunk.length)
        result.set(acc)
        result.set(chunk, acc.length)
        return result
      }, new Uint8Array()),
    )

    const stderr = decoder.decode(
      Chunk.toReadonlyArray(stderrChunks).reduce((acc, chunk) => {
        const result = new Uint8Array(acc.length + chunk.length)
        result.set(acc)
        result.set(chunk, acc.length)
        return result
      }, new Uint8Array()),
    )

    const exitCode = yield* process.exitCode

    if (exitCode !== 0) {
      return yield* Effect.fail(new GitCommandError({ args, exitCode, stderr }))
    }

    return stdout.trim()
  }).pipe(Effect.scoped)

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
    yield* runGitCommand({ args: cmdArgs })
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
    yield* runGitCommand({ args: cmdArgs, cwd: args.repoPath })
  })

/**
 * Checkout a specific ref (branch, tag, or commit)
 */
export const checkout = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    yield* runGitCommand({ args: ['checkout', args.ref], cwd: args.repoPath })
  })

/**
 * Get the current branch name
 */
export const getCurrentBranch = (repoPath: string) =>
  Effect.gen(function* () {
    const result = yield* runGitCommand({
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: repoPath,
    })
    return result === 'HEAD' ? Option.none() : Option.some(result)
  })

/**
 * Get the current commit SHA
 */
export const getCurrentCommit = (repoPath: string) =>
  Effect.gen(function* () {
    return yield* runGitCommand({ args: ['rev-parse', 'HEAD'], cwd: repoPath })
  })

/**
 * Get the remote URL (origin by default)
 */
export const getRemoteUrl = ({
  repoPath,
  remote = 'origin',
}: {
  repoPath: string
  remote?: string
}) =>
  Effect.gen(function* () {
    return yield* runGitCommand({ args: ['remote', 'get-url', remote], cwd: repoPath }).pipe(
      Effect.map(Option.some),
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
  })

/**
 * Check if a directory is a git repository
 */
export const isGitRepo = (path: string) =>
  Effect.gen(function* () {
    return yield* runGitCommand({ args: ['rev-parse', '--git-dir'], cwd: path }).pipe(
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
    yield* runGitCommand({ args: cmdArgs, cwd: args.repoPath })
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
    yield* runGitCommand({ args: cmdArgs, cwd: args.repoPath })
  })

/**
 * List git worktrees
 */
export const listWorktrees = (repoPath: string) =>
  Effect.gen(function* () {
    const output = yield* runGitCommand({
      args: ['worktree', 'list', '--porcelain'],
      cwd: repoPath,
    })
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

    // Flush remaining entry if output doesn't end with blank line
    if (current.path && current.head) {
      worktrees.push({
        path: current.path,
        head: current.head,
        branch: Option.fromNullable(current.branch),
      })
    }

    return worktrees
  })

// =============================================================================
// Bare Repo Operations
// =============================================================================

/**
 * Clone a repository as a bare repo
 */
export const cloneBare = (args: { url: string; targetPath: string }) =>
  clone({ url: args.url, targetPath: args.targetPath, bare: true })

/**
 * Fetch all refs from remote in a bare repo
 * Includes tags and prunes stale refs
 */
export const fetchBare = (args: { repoPath: string; remote?: string }) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    // Fetch all refs including tags, prune stale refs
    yield* runGitCommand({
      args: ['fetch', '--tags', '--prune', remote],
      cwd: args.repoPath,
    })
  })

/**
 * Get the default branch name from a remote
 * Uses `git ls-remote --symref` to query the remote's HEAD
 */
export const getDefaultBranch = (args: { url: string } | { repoPath: string; remote?: string }) =>
  Effect.gen(function* () {
    let output: string

    if ('url' in args) {
      // Query remote directly by URL
      output = yield* runGitCommand({
        args: ['ls-remote', '--symref', args.url, 'HEAD'],
      })
    } else {
      // Query remote by name from existing repo
      const remote = args.remote ?? 'origin'
      output = yield* runGitCommand({
        args: ['ls-remote', '--symref', remote, 'HEAD'],
        cwd: args.repoPath,
      })
    }

    // Parse output: "ref: refs/heads/main\tHEAD"
    const match = output.match(/ref: refs\/heads\/([^\t\n]+)/)
    if (match?.[1]) {
      return Option.some(match[1])
    }
    return Option.none()
  })

/**
 * Resolve a ref to its commit SHA
 * Works with branches, tags, and commits
 */
export const resolveRef = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    return yield* runGitCommand({
      args: ['rev-parse', args.ref],
      cwd: args.repoPath,
    })
  })

/**
 * Check if a ref exists in the repo
 */
export const refExists = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    return yield* runGitCommand({
      args: ['rev-parse', '--verify', args.ref],
      cwd: args.repoPath,
    }).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    )
  })

// =============================================================================
// Enhanced Worktree Operations
// =============================================================================

/**
 * Create a worktree at a specific commit (detached HEAD)
 * Used for tags and specific commits
 */
export const createWorktreeDetached = (args: {
  repoPath: string
  worktreePath: string
  commit: string
}) =>
  Effect.gen(function* () {
    // --detach creates the worktree with a detached HEAD at the specified commit
    yield* runGitCommand({
      args: ['worktree', 'add', '--detach', args.worktreePath, args.commit],
      cwd: args.repoPath,
    })
  })

/**
 * Worktree status information
 */
export interface WorktreeStatus {
  /** Whether the worktree has uncommitted changes */
  readonly isDirty: boolean
  /** Whether the worktree has unpushed commits */
  readonly hasUnpushed: boolean
  /** Number of uncommitted changes */
  readonly changesCount: number
}

/**
 * Get the status of a worktree (dirty state, unpushed commits)
 */
export const getWorktreeStatus = (worktreePath: string) =>
  Effect.gen(function* () {
    // Check for uncommitted changes
    const statusOutput = yield* runGitCommand({
      args: ['status', '--porcelain'],
      cwd: worktreePath,
    })

    const changes = statusOutput.split('\n').filter((line) => line.trim() !== '')
    const isDirty = changes.length > 0

    // Check for unpushed commits (only relevant for branches)
    const unpushedOutput = yield* runGitCommand({
      args: ['log', '@{upstream}..HEAD', '--oneline'],
      cwd: worktreePath,
    }).pipe(
      Effect.map((out) => out.split('\n').filter((line) => line.trim() !== '').length > 0),
      Effect.catchAll(() => Effect.succeed(false)), // No upstream or not a branch
    )

    return {
      isDirty,
      hasUnpushed: unpushedOutput,
      changesCount: changes.length,
    } satisfies WorktreeStatus
  })

/**
 * Update a branch worktree to the latest from remote
 * This is a pull operation (fetch + merge/fast-forward)
 */
export const updateWorktree = (args: { worktreePath: string; remote?: string }) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    // Fetch and merge/rebase
    yield* runGitCommand({
      args: ['pull', '--ff-only', remote],
      cwd: args.worktreePath,
    })
  })

/**
 * Checkout a specific commit in a worktree
 */
export const checkoutWorktree = (args: { worktreePath: string; ref: string }) =>
  Effect.gen(function* () {
    yield* runGitCommand({
      args: ['checkout', args.ref],
      cwd: args.worktreePath,
    })
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
    const remoteUrl = yield* getRemoteUrl({ repoPath })

    return Option.flatMap(remoteUrl, parseGitRemoteUrl).pipe(
      Option.map((parsed) => `${parsed.owner}/${parsed.repo}`),
      Option.getOrElse(() => {
        // Fall back to directory name (filter empty segments for trailing slash support)
        const parts = repoPath.split('/').filter(Boolean)
        return parts[parts.length - 1] ?? 'unknown'
      }),
    )
  })
