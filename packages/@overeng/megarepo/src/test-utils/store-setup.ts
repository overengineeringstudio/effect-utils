/**
 * Store Test Fixtures and Setup Utilities
 *
 * Provides helpers for creating test stores with bare repos and worktrees.
 */

import { Command, FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../lib/config.ts'
import {
  createLockedMember,
  type LockFile,
  type LockedMember,
  LOCK_FILE_NAME,
  writeLockFile,
} from '../lib/lock.ts'
import { encodeRef, refTypeToPathSegment, classifyRef } from '../lib/ref.ts'

// =============================================================================
// Types
// =============================================================================

/** Configuration for a test bare repo in the store */
export interface StoreRepoFixture {
  /** Host (e.g., 'github.com') */
  readonly host: string
  /** Owner */
  readonly owner: string
  /** Repo name */
  readonly repo: string
  /** Branches to create worktrees for */
  readonly branches?: ReadonlyArray<string>
  /** Tags to create worktrees for */
  readonly tags?: ReadonlyArray<string>
  /** Commits to create worktrees for (SHA-like strings) */
  readonly commits?: ReadonlyArray<string>
  /** Whether to make some worktrees dirty */
  readonly dirtyWorktrees?: ReadonlyArray<string>
}

/** Result of creating a store fixture */
export interface StoreFixtureResult {
  /** Path to the store directory */
  readonly storePath: AbsoluteDirPath
  /** Worktree paths by "host/owner/repo#ref" */
  readonly worktreePaths: Record<string, AbsoluteDirPath>
  /** Bare repo paths by "host/owner/repo" */
  readonly bareRepoPaths: Record<string, AbsoluteDirPath>
}

// =============================================================================
// Git Helpers
// =============================================================================

/** Run a git command in a specific directory */
const runGitCommand = (cwd: AbsoluteDirPath, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    const result = yield* Command.string(command)
    return result.trim()
  })

/** Initialize a new git repository */
const initGitRepo = (path: AbsoluteDirPath) =>
  Effect.gen(function* () {
    yield* runGitCommand(path, 'init')
    yield* runGitCommand(path, 'config', 'user.email', 'test@example.com')
    yield* runGitCommand(path, 'config', 'user.name', 'Test User')
  })

// =============================================================================
// Store Fixture Builders
// =============================================================================

/**
 * Create a test store with bare repos and worktrees.
 * The store follows the v2 structure:
 * ```
 * storePath/
 * └── github.com/
 *     └── owner/
 *         └── repo/
 *             ├── .bare/              # bare repo
 *             └── refs/
 *                 ├── heads/
 *                 │   └── main/       # worktree
 *                 ├── tags/
 *                 │   └── v1.0.0/     # worktree
 *                 └── commits/
 *                     └── abc123/     # worktree
 * ```
 */
export const createStoreFixture = (repos: ReadonlyArray<StoreRepoFixture>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory for store
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
    yield* fs.makeDirectory(storePath, { recursive: true })

    const worktreePaths: Record<string, AbsoluteDirPath> = {}
    const bareRepoPaths: Record<string, AbsoluteDirPath> = {}

    for (const repoFixture of repos) {
      const repoKey = `${repoFixture.host}/${repoFixture.owner}/${repoFixture.repo}`

      // Create repo directory structure
      const repoBasePath = EffectPath.ops.join(
        storePath,
        EffectPath.unsafe.relativeDir(`${repoKey}/`),
      )
      const bareRepoPath = EffectPath.ops.join(
        repoBasePath,
        EffectPath.unsafe.relativeDir('.bare/'),
      )

      yield* fs.makeDirectory(bareRepoPath, { recursive: true })
      bareRepoPaths[repoKey] = bareRepoPath

      // Initialize bare repo
      yield* runGitCommand(bareRepoPath, 'init', '--bare')

      // Create a source repo to work with (we need commits to reference)
      const sourceRepoPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('_source/'))
      yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
      yield* initGitRepo(sourceRepoPath)

      // Add a file and commit
      yield* fs.writeFileString(
        EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
        `# ${repoFixture.repo}\n`,
      )
      yield* runGitCommand(sourceRepoPath, 'add', '-A')
      yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Initial commit')

      // Get the commit SHA
      const commitSha = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')

      // Set up bare repo as remote and push
      yield* runGitCommand(sourceRepoPath, 'remote', 'add', 'origin', bareRepoPath)
      yield* runGitCommand(sourceRepoPath, 'push', '-u', 'origin', 'main').pipe(
        Effect.catchAll(() =>
          // Try master if main fails
          runGitCommand(sourceRepoPath, 'push', '-u', 'origin', 'master'),
        ),
      )

      // Create tags if requested
      for (const tag of repoFixture.tags ?? []) {
        yield* runGitCommand(sourceRepoPath, 'tag', tag)
        yield* runGitCommand(sourceRepoPath, 'push', 'origin', tag)
      }

      // Create refs directory structure
      const refsDir = EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('refs/'))
      yield* fs.makeDirectory(refsDir, { recursive: true })

      // Create worktrees for branches
      for (const branch of repoFixture.branches ?? []) {
        const refType = classifyRef(branch)
        const pathSegment = refTypeToPathSegment(refType)
        const encodedRef = encodeRef(branch)
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${encodedRef}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })

        // Create worktree from bare repo
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, commitSha)

        worktreePaths[`${repoKey}#${branch}`] = worktreePath

        // Make dirty if requested
        if (repoFixture.dirtyWorktrees?.includes(branch)) {
          yield* fs.writeFileString(
            EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted changes\n',
          )
        }
      }

      // Create worktrees for tags
      for (const tag of repoFixture.tags ?? []) {
        const refType = classifyRef(tag)
        const pathSegment = refTypeToPathSegment(refType)
        const encodedRef = encodeRef(tag)
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${encodedRef}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, tag)

        worktreePaths[`${repoKey}#${tag}`] = worktreePath

        // Make dirty if requested
        if (repoFixture.dirtyWorktrees?.includes(tag)) {
          yield* fs.writeFileString(
            EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted changes\n',
          )
        }
      }

      // Create worktrees for commits
      for (const commitRef of repoFixture.commits ?? []) {
        const refType = classifyRef(commitRef)
        const pathSegment = refTypeToPathSegment(refType)
        const encodedRef = encodeRef(commitRef)
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${encodedRef}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })
        // Use actual commit SHA for commit worktrees
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, commitSha)

        worktreePaths[`${repoKey}#${commitRef}`] = worktreePath
      }

      // Clean up source repo
      yield* fs.remove(sourceRepoPath, { recursive: true })
    }

    return { storePath, worktreePaths, bareRepoPaths } satisfies StoreFixtureResult
  })

/**
 * Create a workspace with lock file referencing store worktrees.
 */
export const createWorkspaceWithLock = (args: {
  /** Members in config (name -> source string) */
  readonly members: Record<string, string>
  /** Lock file entries (name -> { url, ref, commit }) */
  readonly lockEntries?: Record<
    string,
    { url: string; ref: string; commit: string; pinned?: boolean }
  >
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create workspace directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const workspacePath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('test-workspace/'),
    )
    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: typeof MegarepoConfig.Type = {
      members: args.members,
    }
    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      config,
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )

    // Create lock file if entries provided
    if (args.lockEntries !== undefined && Object.keys(args.lockEntries).length > 0) {
      // Build members object mutably first, then assign to lockFile
      const members: Record<string, LockedMember> = {}

      for (const [name, entry] of Object.entries(args.lockEntries)) {
        members[name] = createLockedMember({
          url: entry.url,
          ref: entry.ref,
          commit: entry.commit,
          ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
        })
      }

      const lockFile: LockFile = {
        version: 1,
        members,
      }

      const lockPath = EffectPath.ops.join(
        workspacePath,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      yield* writeLockFile({ lockPath, lockFile })
    }

    // Commit config
    yield* runGitCommand(workspacePath, 'add', '-A')
    yield* runGitCommand(workspacePath, 'commit', '--no-verify', '-m', 'Initialize megarepo')

    return { workspacePath }
  })

/**
 * Get the commit SHA from a worktree path
 */
export const getWorktreeCommit = (worktreePath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    return yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')
  })
