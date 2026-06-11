/**
 * Store Test Fixtures and Setup Utilities
 *
 * Provides helpers for creating test stores with bare repos and worktrees.
 */

import { Command, FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../lib/config.ts'
import {
  createLockedMember,
  type LockFile,
  type LockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  writeLockFile,
} from '../lib/lock.ts'
import { refTypeToPathSegment, classifyRef } from '../lib/ref.ts'

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
  /**
   * Wire the store bare repo to a separate upstream bare so it has real
   * `refs/remotes/origin/*` (mirrors `Git.cloneBare` + `fetchBare`). Required to
   * exercise reachability (`rev-list --not --remotes`) and prune-driven
   * remote-branch-deletion scenarios.
   */
  readonly withRemote?: boolean
}

/** Result of creating a store fixture */
export interface StoreFixtureResult {
  /** Path to the store directory */
  readonly storePath: AbsoluteDirPath
  /** Worktree paths by "host/owner/repo#ref" */
  readonly worktreePaths: Record<string, AbsoluteDirPath>
  /** Bare repo paths by "host/owner/repo" */
  readonly bareRepoPaths: Record<string, AbsoluteDirPath>
  /** Upstream bare repo paths by "host/owner/repo" (only for `withRemote` repos) */
  readonly upstreamRepoPaths: Record<string, AbsoluteDirPath>
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

/** Initialize a new git repository (writes user config directly to avoid extra process spawns) */
const initGitRepo = (path: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* runGitCommand(path, 'init')
    const configPath = EffectPath.ops.join(path, EffectPath.unsafe.relativeFile('.git/config'))
    const existing = yield* fs.readFileString(configPath)
    yield* fs.writeFileString(
      configPath,
      `${existing}[user]\n\temail = test@example.com\n\tname = Test User\n`,
    )
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
    const upstreamRepoPaths: Record<string, AbsoluteDirPath> = {}

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

      // For `withRemote`, the store bare fetches from a separate upstream bare so
      // it gains real `refs/remotes/origin/*`. The source repo pushes to that
      // upstream (the true remote); otherwise it pushes to the store bare directly.
      const withRemote = repoFixture.withRemote === true
      let pushTargetPath = bareRepoPath
      if (withRemote === true) {
        const upstreamPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir(`_upstream/${repoKey}.bare/`),
        )
        yield* fs.makeDirectory(upstreamPath, { recursive: true })
        yield* runGitCommand(upstreamPath, 'init', '--bare')
        upstreamRepoPaths[repoKey] = upstreamPath
        pushTargetPath = upstreamPath
      }

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

      // Set up remote and push branches
      yield* runGitCommand(sourceRepoPath, 'remote', 'add', 'origin', pushTargetPath)
      yield* runGitCommand(sourceRepoPath, 'push', '-u', 'origin', 'main').pipe(
        Effect.catchAll(() =>
          // Try master if main fails
          runGitCommand(sourceRepoPath, 'push', '-u', 'origin', 'master'),
        ),
      )
      // Push any additional branches requested (beyond the default).
      for (const branch of repoFixture.branches ?? []) {
        if (branch === 'main' || branch === 'master') continue
        yield* runGitCommand(sourceRepoPath, 'branch', branch, commitSha).pipe(
          Effect.catchAll(() => Effect.void),
        )
        yield* runGitCommand(sourceRepoPath, 'push', 'origin', branch).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }

      // Create tags if requested
      for (const tag of repoFixture.tags ?? []) {
        yield* runGitCommand(sourceRepoPath, 'tag', '--no-sign', tag)
        yield* runGitCommand(sourceRepoPath, 'push', 'origin', tag)
      }

      // Wire the store bare to the upstream so it gains `refs/remotes/origin/*`
      // (mirrors Git.cloneBare's refspec + Git.fetchBare).
      if (withRemote === true) {
        yield* runGitCommand(bareRepoPath, 'remote', 'add', 'origin', upstreamRepoPaths[repoKey]!)
        yield* runGitCommand(
          bareRepoPath,
          'config',
          'remote.origin.fetch',
          '+refs/heads/*:refs/remotes/origin/*',
        )
        yield* runGitCommand(bareRepoPath, 'fetch', '--tags', '--prune', 'origin')
      }

      // Create refs directory structure
      const refsDir = EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('refs/'))
      yield* fs.makeDirectory(refsDir, { recursive: true })

      // Create worktrees for branches
      for (const branch of repoFixture.branches ?? []) {
        const refType = classifyRef(branch)
        const pathSegment = refTypeToPathSegment(refType)
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${branch}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })

        // Create worktree from bare repo
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, commitSha)

        worktreePaths[`${repoKey}#${branch}`] = worktreePath

        // Make dirty if requested
        if (repoFixture.dirtyWorktrees?.includes(branch) === true) {
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
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${tag}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, tag)

        worktreePaths[`${repoKey}#${tag}`] = worktreePath

        // Make dirty if requested
        if (repoFixture.dirtyWorktrees?.includes(tag) === true) {
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
        const worktreePath = EffectPath.ops.join(
          repoBasePath,
          EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${commitRef}/`),
        )

        yield* fs.makeDirectory(worktreePath, { recursive: true })
        // Use actual commit SHA for commit worktrees
        yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', worktreePath, commitSha)

        worktreePaths[`${repoKey}#${commitRef}`] = worktreePath
      }

      // Clean up source repo
      yield* fs.remove(sourceRepoPath, { recursive: true })
    }

    return {
      storePath,
      worktreePaths,
      bareRepoPaths,
      upstreamRepoPaths,
    } satisfies StoreFixtureResult
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
  runGitCommand(worktreePath, 'rev-parse', 'HEAD')

/**
 * Repoint a workspace member to a new store target WITHOUT re-registering.
 *
 * Models the decision-0010 repin bug: a workspace repins a member (its
 * `repos/<name>` symlink and lock entry now point at `newTarget`) but runs no
 * refreshing command, so its liveness record stays stale. The store registry is
 * deliberately left untouched — only the on-disk truth (symlink + optional lock)
 * is updated. A reconcile-all must re-derive the new target from disk.
 */
export const repinWorkspace = ({
  workspacePath,
  memberName,
  newTarget,
  lockEntry,
}: {
  workspacePath: AbsoluteDirPath
  memberName: string
  newTarget: AbsoluteDirPath
  lockEntry?: { url: string; ref: string; commit: string; pinned?: boolean } | undefined
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
    yield* fs.makeDirectory(reposDir, { recursive: true })
    const symlinkPath = EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile(memberName))
    // Replace any existing symlink so the new target is the on-disk truth.
    yield* fs.remove(symlinkPath, { force: true }).pipe(Effect.catchAll(() => Effect.void))
    yield* fs.symlink(newTarget.replace(/\/+$/, ''), symlinkPath)

    // Optionally rewrite the lock entry for this member (ref/commit repin),
    // preserving every other member verbatim.
    if (lockEntry !== undefined) {
      const lockPath = EffectPath.ops.join(
        workspacePath,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const existingOpt = yield* readLockFile(lockPath)
      const members: Record<string, LockedMember> = {}
      for (const [name, member] of Object.entries(
        Option.getOrUndefined(existingOpt)?.members ?? {},
      )) {
        members[name] = member
      }
      members[memberName] = createLockedMember({
        url: lockEntry.url,
        ref: lockEntry.ref,
        commit: lockEntry.commit,
        ...(lockEntry.pinned !== undefined ? { pinned: lockEntry.pinned } : {}),
      })
      const lockFile: LockFile = { version: 1, members }
      yield* writeLockFile({ lockPath, lockFile })
    }
  })

/**
 * Create a valid archive entry (`<repoRoot>/.archive/<branch>--<ISO8601>/`)
 * registered as a worktree of the bare repo (proper gitlink), for exercising
 * retention/reap. `archivedAt` controls the trailing timestamp segment used by
 * the reaper's retention TTL parse.
 */
export const createArchiveEntry = ({
  bareRepoPath,
  repoRoot,
  branch,
  commit,
  archivedAt,
}: {
  bareRepoPath: AbsoluteDirPath
  repoRoot: AbsoluteDirPath
  branch: string
  commit: string
  archivedAt: Date
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const archiveDir = EffectPath.ops.join(repoRoot, EffectPath.unsafe.relativeDir('.archive/'))
    yield* fs.makeDirectory(archiveDir, { recursive: true })

    const dirName = `${branch}--${archivedAt.toISOString()}`
    const archivePath = EffectPath.ops.join(
      archiveDir,
      EffectPath.unsafe.relativeDir(`${dirName}/`),
    )
    // `worktree add --detach` creates a real gitlink and registers the path in
    // the bare's worktree list (the same enumeration the reaper scans).
    yield* runGitCommand(bareRepoPath, 'worktree', 'add', '--detach', archivePath, commit)
    return { archivePath, dirName }
  })
