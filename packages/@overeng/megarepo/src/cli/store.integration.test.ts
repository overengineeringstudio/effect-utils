/**
 * Store Commands Integration Tests
 *
 * Tests the store GC, ls, and fetch commands with realistic store fixtures.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { parseSourceString, isRemoteSource } from '../lib/config.ts'
import * as Git from '../lib/git.ts'
import { LOCK_FILE_NAME, readLockFile } from '../lib/lock.ts'
import { refreshWorkspaceRegistry } from '../lib/store-liveness.ts'
import { makeStoreLayer, Store } from '../lib/store.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
} from '../test-utils/store-setup.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

const StoreGcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.String,
      path: Schema.String,
      status: Schema.String,
      message: Schema.optional(Schema.String),
    }),
  ),
})

const decodeStoreGcJsonOutput = Schema.decodeUnknownSync(Schema.parseJson(StoreGcJsonOutput))

type StoreGcJsonResult = Schema.Schema.Type<typeof StoreGcJsonOutput>['results'][number]

const findGcResult = (results: ReadonlyArray<StoreGcJsonResult>, repo: string, ref: string) =>
  results.find((result) => result.repo === repo && result.ref === ref)

const runMrCommand = ({
  cwd,
  command,
  env,
}: {
  cwd: AbsoluteDirPath
  command: ReadonlyArray<string>
  env: Record<string, string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previousEnv = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = new Map<string, string | undefined>()
        for (const [key, value] of Object.entries(env)) {
          previous.set(key, process.env[key])
          process.env[key] = value
        }
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          for (const [key, value] of previous) {
            if (value === undefined) {
              delete process.env[key]
            } else {
              process.env[key] = value
            }
          }
        }),
    )

    const argv = ['node', 'mr', ...command]
    const exit = yield* Cli.Command.run(mrCommand, { name: 'mr', version: 'test' })(argv).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(consoleLayer),
      Effect.exit,
    )
    void previousEnv

    return {
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      stdout: (yield* getStdoutLines).join('\n'),
    }
  }).pipe(Effect.scoped)

describe('mr store gc', () => {
  describe('with unused worktrees', () => {
    it.effect(
      'should identify unused worktrees when not in a megarepo',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a store with some repos and worktrees
          const { storePath, worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'test-repo',
              branches: ['main', 'feature-a'],
            },
          ])

          // Verify worktrees were created
          expect(worktreePaths['github.com/test-owner/test-repo#main']).toBeDefined()
          expect(worktreePaths['github.com/test-owner/test-repo#feature-a']).toBeDefined()

          // Verify worktrees exist on disk
          const mainWorktreePath = worktreePaths['github.com/test-owner/test-repo#main']!
          const featureWorktreePath = worktreePaths['github.com/test-owner/test-repo#feature-a']!

          expect(yield* fs.exists(mainWorktreePath)).toBe(true)
          expect(yield* fs.exists(featureWorktreePath)).toBe(true)

          // Use the store to list worktrees
          const storeLayer = makeStoreLayer({ basePath: storePath })
          const store = yield* Store.pipe(Effect.provide(storeLayer))

          const repos = yield* store.listRepos()
          expect(repos).toHaveLength(1)
          expect(repos[0]?.relativePath).toBe('github.com/test-owner/test-repo/')
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should skip dirty worktrees without --force',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create store with a dirty worktree
          const { storePath, worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'dirty-repo',
              branches: ['main'],
              dirtyWorktrees: ['main'],
            },
          ])

          const mainWorktreePath = worktreePaths['github.com/test-owner/dirty-repo#main']!

          // Verify dirty file was created
          const dirtyFilePath = EffectPath.ops.join(
            mainWorktreePath,
            EffectPath.unsafe.relativeFile('dirty.txt'),
          )
          expect(yield* fs.exists(dirtyFilePath)).toBe(true)

          // Use store to verify structure
          const storeLayer = makeStoreLayer({ basePath: storePath })
          const store = yield* Store.pipe(Effect.provide(storeLayer))

          const repos = yield* store.listRepos()
          expect(repos).toHaveLength(1)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('with workspace lock file', () => {
    it.effect(
      'should mark worktrees as in-use when referenced in lock file',
      Effect.fnUntraced(
        function* () {
          // Create store with worktrees
          const { worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'locked-repo',
              branches: ['main', 'unused-branch'],
            },
          ])

          // Get commit SHA from the main worktree
          const mainWorktreePath = worktreePaths['github.com/test-owner/locked-repo#main']!
          const commitSha = yield* getWorktreeCommit(mainWorktreePath)

          // Create workspace with lock file referencing main branch
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': 'test-owner/locked-repo',
            },
            lockEntries: {
              'my-lib': {
                url: 'git@github.com:test-owner/locked-repo.git',
                ref: 'main',
                commit: commitSha,
              },
            },
          })

          // Verify lock file was created
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)
          expect(lockFile.members['my-lib']).toBeDefined()
          expect(lockFile.members['my-lib']!.ref).toBe('main')
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should protect active worktrees registered by another workspace',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          const { storePath, worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'repo-a',
              branches: ['main'],
            },
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'repo-b',
              branches: ['main'],
            },
          ])

          const repoAPath = worktreePaths['github.com/test-owner/repo-a#main']!
          const repoBPath = worktreePaths['github.com/test-owner/repo-b#main']!
          const repoACommit = yield* getWorktreeCommit(repoAPath)
          const repoBCommit = yield* getWorktreeCommit(repoBPath)

          const { workspacePath: workspaceA } = yield* createWorkspaceWithLock({
            members: { 'repo-a': 'test-owner/repo-a#main' },
            lockEntries: {
              'repo-a': {
                url: 'git@github.com:test-owner/repo-a.git',
                ref: 'main',
                commit: repoACommit,
              },
            },
          })
          const { workspacePath: workspaceB } = yield* createWorkspaceWithLock({
            members: { 'repo-b': 'test-owner/repo-b#main' },
            lockEntries: {
              'repo-b': {
                url: 'git@github.com:test-owner/repo-b.git',
                ref: 'main',
                commit: repoBCommit,
              },
            },
          })

          yield* fs.makeDirectory(
            EffectPath.ops.join(workspaceA, EffectPath.unsafe.relativeDir('repos/')),
            { recursive: true },
          )
          yield* fs.makeDirectory(
            EffectPath.ops.join(workspaceB, EffectPath.unsafe.relativeDir('repos/')),
            { recursive: true },
          )
          yield* fs.symlink(
            repoAPath.replace(/\/$/, ''),
            EffectPath.ops.join(workspaceA, EffectPath.unsafe.relativeFile('repos/repo-a')),
          )
          yield* fs.symlink(
            repoBPath.replace(/\/$/, ''),
            EffectPath.ops.join(workspaceB, EffectPath.unsafe.relativeFile('repos/repo-b')),
          )

          const env = { MEGAREPO_STORE: storePath }
          const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
          yield* refreshWorkspaceRegistry({ workspaceRoot: workspaceB, store, now: Date.now() })
          const statusB = yield* runMrCommand({
            cwd: workspaceB,
            command: ['status', '--output', 'json'],
            env,
          })
          expect(statusB.exitCode).toBe(0)

          const gcA = yield* runMrCommand({
            cwd: workspaceA,
            command: ['store', 'gc', '--dry-run', '--output', 'json'],
            env,
          })
          expect(gcA.exitCode).toBe(0)
          const json = decodeStoreGcJsonOutput(gcA.stdout)
          const repoBResult = json.results.find((r) => r.repo === 'github.com/test-owner/repo-b/')
          // Named branch worktrees registered by another workspace are now owned
          // by the cold reclamation path (decisions 0001–0010): the worktree is
          // still PROTECTED, surfaced as `kept` (the prior status was the
          // commit-path `skipped_in_use`). The protection guarantee is unchanged.
          expect(repoBResult?.status).toBe('kept')
          expect(yield* fs.exists(repoBPath)).toBe(true)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should protect the current workspace commit-mode symlink target',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          const commitRef = 'abcdef1234567890abcdef1234567890abcdef12'
          const { storePath, worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'commit-mode-repo',
              commits: [commitRef],
            },
          ])

          const commitWorktreePath =
            worktreePaths[`github.com/test-owner/commit-mode-repo#${commitRef}`]!
          const commit = yield* getWorktreeCommit(commitWorktreePath)

          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { repo: 'test-owner/commit-mode-repo#main' },
            lockEntries: {
              repo: {
                url: 'git@github.com:test-owner/commit-mode-repo.git',
                ref: 'main',
                commit,
              },
            },
          })

          yield* fs.makeDirectory(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
            { recursive: true },
          )
          yield* fs.symlink(
            commitWorktreePath.replace(/\/$/, ''),
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/repo')),
          )
          const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
          yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: Date.now() })

          const gc = yield* runMrCommand({
            cwd: workspacePath,
            command: ['store', 'gc', '--output', 'json'],
            env: { MEGAREPO_STORE: storePath },
          })
          expect(gc.exitCode).toBe(0)
          const json = decodeStoreGcJsonOutput(gc.stdout)
          const commitResult = findGcResult(
            json.results,
            'github.com/test-owner/commit-mode-repo/',
            commitRef,
          )
          expect(commitResult?.status).toBe('skipped_in_use')
          expect(yield* fs.exists(commitWorktreePath)).toBe(true)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should keep clean heads and tags while removing clean unprotected commit worktrees by default',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const commitRef = 'abcdef1234567890abcdef1234567890abcdef12'

          const { storePath, worktreePaths } = yield* createStoreFixture([
            {
              host: 'github.com',
              owner: 'test-owner',
              repo: 'default-policy-repo',
              branches: ['main'],
              tags: ['v1.0.0'],
              commits: [commitRef],
            },
          ])

          const branchWorktreePath =
            worktreePaths['github.com/test-owner/default-policy-repo#main']!
          const tagWorktreePath = worktreePaths['github.com/test-owner/default-policy-repo#v1.0.0']!
          const commitWorktreePath =
            worktreePaths[`github.com/test-owner/default-policy-repo#${commitRef}`]!

          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const cwd = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outside/'))
          yield* fs.makeDirectory(cwd, { recursive: true })

          const gc = yield* runMrCommand({
            cwd,
            command: ['store', 'gc', '--output', 'json'],
            env: { MEGAREPO_STORE: storePath },
          })
          expect(gc.exitCode).toBe(0)
          const json = decodeStoreGcJsonOutput(gc.stdout)
          const branchResult = json.results.find((r) => r.path === branchWorktreePath)
          const tagResult = json.results.find((r) => r.path === tagWorktreePath)
          const commitResult = json.results.find((r) => r.path === commitWorktreePath)

          expect(branchResult?.status).not.toBe('removed')
          expect(tagResult?.status).not.toBe('removed')
          expect(commitResult?.status).toBe('removed')
          expect(yield* fs.exists(branchWorktreePath)).toBe(true)
          expect(yield* fs.exists(tagWorktreePath)).toBe(true)
          expect(yield* fs.exists(commitWorktreePath)).toBe(false)

          const bareRepoPath = EffectPath.ops.join(
            storePath,
            EffectPath.unsafe.relativeDir('github.com/test-owner/default-policy-repo/.bare/'),
          )
          const gitWorktrees = yield* Git.listWorktrees(bareRepoPath)
          expect(
            gitWorktrees.some(
              (worktree) => worktree.path === commitWorktreePath.replace(/\/$/, ''),
            ),
          ).toBe(false)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})

describe('mr store ls', () => {
  it.effect(
    'should list repos in the store',
    Effect.fnUntraced(
      function* () {
        // Create store with multiple repos
        const { storePath } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'owner1',
            repo: 'repo-a',
            branches: ['main'],
          },
          {
            host: 'github.com',
            owner: 'owner2',
            repo: 'repo-b',
            branches: ['main'],
          },
        ])

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        const repos = yield* store.listRepos()
        expect(repos).toHaveLength(2)

        const paths = repos.map((r) => r.relativePath).sort()
        expect(paths).toContain('github.com/owner1/repo-a/')
        expect(paths).toContain('github.com/owner2/repo-b/')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should return empty list for empty store',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create empty store directory
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        yield* fs.makeDirectory(storePath, { recursive: true })

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        const repos = yield* store.listRepos()
        expect(repos).toHaveLength(0)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should ignore internal scratch roots when listing repos',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        const repoPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('localhost/owner/repo/'),
        )
        const scratchRepoPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('tmp/owner/repo/'),
        )

        yield* fs.makeDirectory(
          EffectPath.ops.join(repoPath, EffectPath.unsafe.relativeDir('.bare/')),
          { recursive: true },
        )
        yield* fs.makeDirectory(
          EffectPath.ops.join(scratchRepoPath, EffectPath.unsafe.relativeDir('.bare/')),
          { recursive: true },
        )

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        const repos = yield* store.listRepos()
        expect(repos.map((repo) => repo.relativePath)).toStrictEqual(['localhost/owner/repo/'])
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should discover repos below path segments named refs',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        const repoPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('example.com/refs/project/'),
        )
        yield* fs.makeDirectory(
          EffectPath.ops.join(repoPath, EffectPath.unsafe.relativeDir('.bare/')),
          { recursive: true },
        )

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        const repos = yield* store.listRepos()
        expect(repos.map((repo) => repo.relativePath)).toContain('example.com/refs/project/')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('store worktree paths', () => {
  it.effect(
    'should generate correct worktree paths for different ref types',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create store directory
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        yield* fs.makeDirectory(storePath, { recursive: true })

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        // Test path generation for branch
        const branchSource = parseSourceString('owner/repo#main')!
        const branchPath = store.getWorktreePath({
          source: branchSource,
          ref: 'main',
        })
        expect(branchPath).toContain('refs/heads/main/')

        // Test path generation for tag
        const tagSource = parseSourceString('owner/repo#v1.0.0')!
        const tagPath = store.getWorktreePath({
          source: tagSource,
          ref: 'v1.0.0',
        })
        expect(tagPath).toContain('refs/tags/v1.0.0/')

        // Test path generation for commit (must be exactly 40 hex chars)
        const commitRef = 'abcdef1234567890abcdef1234567890abcdef12'
        const commitSource = parseSourceString(`owner/repo#${commitRef}`)!
        const commitPath = store.getWorktreePath({
          source: commitSource,
          ref: commitRef,
        })
        expect(commitPath).toContain('refs/commits/')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should preserve raw nested branch paths in ref names',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        yield* fs.makeDirectory(storePath, { recursive: true })

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        // Test path generation for branch with special characters
        const source = parseSourceString('owner/repo')!
        const pathWithSlash = store.getWorktreePath({
          source,
          ref: 'feature/my-branch',
        })
        expect(pathWithSlash).toContain('refs/heads/feature/my-branch/')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('lock file pin/unpin operations', () => {
  it.effect(
    'should pin a member in the lock file',
    Effect.fnUntraced(
      function* () {
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            'my-lib': 'owner/repo',
          },
          lockEntries: {
            'my-lib': {
              url: 'git@github.com:owner/repo.git',
              ref: 'main',
              commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              pinned: false,
            },
          },
        })

        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )

        // Read lock file and verify initial state
        const lockFileOpt = yield* readLockFile(lockPath)
        const lockFile = Option.getOrThrow(lockFileOpt)
        expect(lockFile.members['my-lib']!.pinned).toBe(false)

        // Import and use pinMember
        const { pinMember } = yield* Effect.promise(() => import('../lib/lock.ts'))
        const pinnedLockFile = pinMember({ lockFile, memberName: 'my-lib' })

        // Verify the member is now pinned
        expect(pinnedLockFile.members['my-lib']!.pinned).toBe(true)
        expect(pinnedLockFile.members['my-lib']!.commit).toBe(
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        )
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should unpin a member in the lock file',
    Effect.fnUntraced(
      function* () {
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            'my-lib': 'owner/repo',
          },
          lockEntries: {
            'my-lib': {
              url: 'git@github.com:owner/repo.git',
              ref: 'main',
              commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              pinned: true,
            },
          },
        })

        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )

        // Read lock file and verify initial state
        const lockFileOpt = yield* readLockFile(lockPath)
        const lockFile = Option.getOrThrow(lockFileOpt)
        expect(lockFile.members['my-lib']!.pinned).toBe(true)

        // Import and use unpinMember
        const { unpinMember } = yield* Effect.promise(() => import('../lib/lock.ts'))
        const unpinnedLockFile = unpinMember({
          lockFile,
          memberName: 'my-lib',
        })

        // Verify the member is now unpinned
        expect(unpinnedLockFile.members['my-lib']!.pinned).toBe(false)
        expect(unpinnedLockFile.members['my-lib']!.commit).toBe(
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        )
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should not modify other members when pinning/unpinning',
    Effect.fnUntraced(
      function* () {
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            lib1: 'owner/lib1',
            lib2: 'owner/lib2',
          },
          lockEntries: {
            lib1: {
              url: 'git@github.com:owner/lib1.git',
              ref: 'main',
              commit: '1111111111111111111111111111111111111111',
              pinned: false,
            },
            lib2: {
              url: 'git@github.com:owner/lib2.git',
              ref: 'main',
              commit: '2222222222222222222222222222222222222222',
              pinned: false,
            },
          },
        })

        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )

        const lockFileOpt = yield* readLockFile(lockPath)
        const lockFile = Option.getOrThrow(lockFileOpt)

        // Pin lib1
        const { pinMember } = yield* Effect.promise(() => import('../lib/lock.ts'))
        const pinnedLockFile = pinMember({ lockFile, memberName: 'lib1' })

        // Verify lib1 is pinned but lib2 is unchanged
        expect(pinnedLockFile.members['lib1']!.pinned).toBe(true)
        expect(pinnedLockFile.members['lib2']!.pinned).toBe(false)
        expect(pinnedLockFile.members['lib2']!.commit).toBe(
          '2222222222222222222222222222222222222222',
        )
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('lock file operations', () => {
  it.effect(
    'should create and read lock file with pinned member',
    Effect.fnUntraced(
      function* () {
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            'pinned-lib': 'owner/repo',
          },
          lockEntries: {
            'pinned-lib': {
              url: 'git@github.com:owner/repo.git',
              ref: 'main',
              commit: 'abc1234567890abcdef1234567890abcdef1234',
              pinned: true,
            },
          },
        })

        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const lockFileOpt = yield* readLockFile(lockPath)
        expect(Option.isSome(lockFileOpt)).toBe(true)

        const lockFile = Option.getOrThrow(lockFileOpt)
        expect(lockFile.members['pinned-lib']).toBeDefined()
        expect(lockFile.members['pinned-lib']!.pinned).toBe(true)
        expect(lockFile.members['pinned-lib']!.commit).toBe(
          'abc1234567890abcdef1234567890abcdef1234',
        )
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should handle multiple members with different pin states',
    Effect.fnUntraced(
      function* () {
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            lib1: 'owner/lib1',
            lib2: 'owner/lib2',
            lib3: 'owner/lib3',
          },
          lockEntries: {
            lib1: {
              url: 'git@github.com:owner/lib1.git',
              ref: 'main',
              commit: '1111111111111111111111111111111111111111',
              pinned: true,
            },
            lib2: {
              url: 'git@github.com:owner/lib2.git',
              ref: 'v2.0.0',
              commit: '2222222222222222222222222222222222222222',
              pinned: false,
            },
            lib3: {
              url: 'git@github.com:owner/lib3.git',
              ref: 'develop',
              commit: '3333333333333333333333333333333333333333',
              pinned: false,
            },
          },
        })

        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const lockFileOpt = yield* readLockFile(lockPath)
        const lockFile = Option.getOrThrow(lockFileOpt)

        expect(Object.keys(lockFile.members)).toHaveLength(3)
        expect(lockFile.members['lib1']!.pinned).toBe(true)
        expect(lockFile.members['lib2']!.pinned).toBe(false)
        expect(lockFile.members['lib3']!.pinned).toBe(false)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('source string parsing', () => {
  it('should correctly identify remote vs local sources', () => {
    // GitHub shorthand
    const github = parseSourceString('owner/repo')
    expect(github).toBeDefined()
    expect(github!.type).toBe('github')
    expect(isRemoteSource(github!)).toBe(true)

    // GitHub shorthand with ref
    const githubWithRef = parseSourceString('owner/repo#main')
    expect(githubWithRef).toBeDefined()
    expect(githubWithRef!.type).toBe('github')
    expect(isRemoteSource(githubWithRef!)).toBe(true)

    // SSH URL
    const sshUrl = parseSourceString('git@github.com:owner/repo.git')
    expect(sshUrl).toBeDefined()
    expect(sshUrl!.type).toBe('url')
    expect(isRemoteSource(sshUrl!)).toBe(true)

    // HTTPS URL
    const httpsUrl = parseSourceString('https://github.com/owner/repo.git')
    expect(httpsUrl).toBeDefined()
    expect(httpsUrl!.type).toBe('url')
    expect(isRemoteSource(httpsUrl!)).toBe(true)

    // Local path
    const localPath = parseSourceString('/path/to/repo')
    expect(localPath).toBeDefined()
    expect(localPath!.type).toBe('path')
    expect(isRemoteSource(localPath!)).toBe(false)

    // Relative path
    const relativePath = parseSourceString('./relative/repo')
    expect(relativePath).toBeDefined()
    expect(relativePath!.type).toBe('path')
    expect(isRemoteSource(relativePath!)).toBe(false)

    // Home path
    const homePath = parseSourceString('~/my-repos/lib')
    expect(homePath).toBeDefined()
    expect(homePath!.type).toBe('path')
    expect(isRemoteSource(homePath!)).toBe(false)
  })
})
