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
    return yield* runGitCommand({
      args: ['remote', 'get-url', remote],
      cwd: repoPath,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
  })

/**
 * Check if a directory is a git repository
 */
export const isGitRepo = (path: string) =>
  Effect.gen(function* () {
    return yield* runGitCommand({
      args: ['rev-parse', '--git-dir'],
      cwd: path,
    }).pipe(
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
    const worktrees: Array<{
      path: string
      head: string
      branch: Option.Option<string>
    }> = []

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
// Branch Operations
// =============================================================================

/**
 * Create a new branch in a bare repo from a base ref.
 * The branch is created locally and can then be pushed.
 *
 * @param repoPath - Path to the bare repo
 * @param branch - Name of the new branch to create
 * @param baseRef - The ref to create the branch from (commit, tag, or branch)
 */
export const createBranch = (args: { repoPath: string; branch: string; baseRef: string }) =>
  Effect.gen(function* () {
    // Resolve the base ref to a commit
    const baseCommit = yield* resolveRef({ repoPath: args.repoPath, ref: args.baseRef })

    // Create the branch pointing to that commit
    yield* runGitCommand({
      args: ['branch', args.branch, baseCommit],
      cwd: args.repoPath,
    })

    return baseCommit
  })

/**
 * Push a branch to the remote.
 *
 * @param repoPath - Path to the bare repo
 * @param branch - Name of the branch to push
 * @param remote - Remote name (default: 'origin')
 * @param setUpstream - Whether to set upstream tracking (default: true)
 */
export const pushBranch = (args: {
  repoPath: string
  branch: string
  remote?: string | undefined
  setUpstream?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const remote = args.remote ?? 'origin'
    const cmdArgs = ['push']
    if (args.setUpstream !== false) {
      cmdArgs.push('-u')
    }
    cmdArgs.push(remote, args.branch)

    yield* runGitCommand({
      args: cmdArgs,
      cwd: args.repoPath,
    })
  })

/**
 * Create a new branch and push it to the remote.
 * Combines createBranch and pushBranch for convenience.
 */
export const createAndPushBranch = (args: {
  repoPath: string
  branch: string
  baseRef: string
  remote?: string
}) =>
  Effect.gen(function* () {
    const baseCommit = yield* createBranch({
      repoPath: args.repoPath,
      branch: args.branch,
      baseRef: args.baseRef,
    })

    yield* pushBranch({
      repoPath: args.repoPath,
      branch: args.branch,
      remote: args.remote,
    })

    return baseCommit
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

// =============================================================================
// Remote Ref Type Detection
// =============================================================================

/** The type of a git ref as determined by the remote */
export type RemoteRefType = 'tag' | 'branch' | 'unknown'

/** Result of querying remote refs */
export interface RemoteRefInfo {
  readonly type: RemoteRefType
  readonly commit: string
}

/**
 * Query a remote to determine the actual type of a ref (tag vs branch).
 * This is more accurate than heuristic-based detection.
 *
 * @returns The ref type and commit SHA, or 'unknown' if the ref doesn't exist
 */
export const queryRemoteRefType = (args: { url: string; ref: string }) =>
  Effect.gen(function* () {
    // Query both tags and heads from remote
    const output = yield* runGitCommand({
      args: ['ls-remote', '--refs', args.url],
    }).pipe(Effect.catchAll(() => Effect.succeed('')))

    if (output.length === 0) {
      return { type: 'unknown' as const, commit: '' }
    }

    // Parse output: "sha\trefs/heads/branch" or "sha\trefs/tags/tag"
    const lines = output.split('\n').filter((line) => line.trim().length > 0)

    // Look for exact match
    for (const line of lines) {
      const [commit, refPath] = line.split('\t')
      if (commit === undefined || refPath === undefined) continue

      // Check if this is our ref
      if (refPath === `refs/tags/${args.ref}`) {
        return { type: 'tag' as const, commit }
      }
      if (refPath === `refs/heads/${args.ref}`) {
        return { type: 'branch' as const, commit }
      }
    }

    return { type: 'unknown' as const, commit: '' }
  })

/**
 * Query a bare repo to determine the actual type of a ref (tag vs branch).
 * Uses local refs after fetch.
 */
export const queryLocalRefType = (args: { repoPath: string; ref: string }) =>
  Effect.gen(function* () {
    // Check if it's a tag
    const tagExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/tags/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.catchAll(() => Effect.succeed({ exists: false, commit: '' })),
    )

    if (tagExists.exists) {
      return { type: 'tag' as const, commit: tagExists.commit }
    }

    // Check if it's a branch (remote tracking)
    const branchExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/remotes/origin/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.catchAll(() => Effect.succeed({ exists: false, commit: '' })),
    )

    if (branchExists.exists) {
      return { type: 'branch' as const, commit: branchExists.commit }
    }

    // Check local branch (less common in bare repos but possible)
    const localBranchExists = yield* runGitCommand({
      args: ['rev-parse', '--verify', `refs/heads/${args.ref}`],
      cwd: args.repoPath,
    }).pipe(
      Effect.map((commit) => ({ exists: true, commit })),
      Effect.catchAll(() => Effect.succeed({ exists: false, commit: '' })),
    )

    if (localBranchExists.exists) {
      return { type: 'branch' as const, commit: localBranchExists.commit }
    }

    return { type: 'unknown' as const, commit: '' }
  })

/**
 * Validate that a ref exists, using hybrid approach:
 * - If bare repo exists locally, check there (fast, no network)
 * - If bare repo doesn't exist, query remote via ls-remote (accurate for new repos)
 *
 * @returns Object with `exists` boolean and optional `type` ('branch' | 'tag' | 'commit')
 */
export const validateRefExists = (args: {
  ref: string
  bareRepoPath: string | undefined
  bareExists: boolean
  cloneUrl: string
}) =>
  Effect.gen(function* () {
    const { ref, bareRepoPath, bareExists, cloneUrl } = args

    // If it looks like a commit SHA, we can't validate without the repo
    // Just assume it's valid - it will fail later if not
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      return { exists: true, type: 'commit' as const }
    }

    if (bareExists && bareRepoPath !== undefined) {
      // Check locally (fast path)
      const localResult = yield* queryLocalRefType({ repoPath: bareRepoPath, ref })
      if (localResult.type !== 'unknown') {
        return { exists: true, type: localResult.type }
      }
      // Ref not found locally - could be a new remote branch
      // Fall through to remote check
    }

    // Check remote (slower but accurate for new repos or refs)
    const remoteResult = yield* queryRemoteRefType({ url: cloneUrl, ref })
    if (remoteResult.type !== 'unknown') {
      return { exists: true, type: remoteResult.type }
    }

    return { exists: false, type: undefined }
  })

// =============================================================================
// Error Message Interpretation
// =============================================================================

/**
 * Interpret a git error and return a user-friendly message with hints.
 */
export const interpretGitError = (error: GitCommandError): { message: string; hint?: string } => {
  const stderr = error.stderr.toLowerCase()
  const args = error.args

  // Repository not found / access denied
  if (
    stderr.includes('repository not found') ||
    stderr.includes('could not read from remote') ||
    stderr.includes('permission denied')
  ) {
    return {
      message: 'Repository not found or access denied',
      hint: 'Check the repository URL and your access permissions',
    }
  }

  // Authentication required
  if (
    stderr.includes('could not read username') ||
    stderr.includes('authentication failed') ||
    stderr.includes('invalid credentials')
  ) {
    return {
      message: 'Authentication required',
      hint: 'Configure git credentials or use SSH with an SSH key',
    }
  }

  // Ref not found (ambiguous argument)
  if (stderr.includes('ambiguous argument') || stderr.includes('unknown revision')) {
    // Extract the ref from the error or args
    const refMatch = error.stderr.match(/ambiguous argument '([^']+)'/)
    const ref = refMatch?.[1] ?? args.find((a) => !a.startsWith('-'))
    return {
      message: `Ref '${ref}' not found`,
      hint: `Check available refs with: git ls-remote --refs <url>`,
    }
  }

  // Clone destination exists
  if (stderr.includes('already exists and is not an empty directory')) {
    return {
      message: 'Target directory already exists',
      hint: 'Remove the directory or choose a different location',
    }
  }

  // Network errors
  if (
    stderr.includes('could not resolve host') ||
    stderr.includes('network is unreachable') ||
    stderr.includes('connection refused')
  ) {
    return {
      message: 'Network error - could not connect to remote',
      hint: 'Check your internet connection and the repository URL',
    }
  }

  // SSH errors
  if (stderr.includes('host key verification failed') || stderr.includes('no such identity')) {
    return {
      message: 'SSH connection failed',
      hint: 'Check your SSH configuration and keys',
    }
  }

  // Default: use original message but clean it up
  return {
    message: error.message.split('\n')[0] ?? error.message,
  }
}
