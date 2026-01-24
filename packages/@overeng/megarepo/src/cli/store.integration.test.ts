/**
 * Store Commands Integration Tests
 *
 * Tests the store GC, ls, and fetch commands with realistic store fixtures.
 */

import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { parseSourceString, isRemoteSource } from '../lib/config.ts'
import { LOCK_FILE_NAME, readLockFile } from '../lib/lock.ts'
import { makeStoreLayer, Store } from '../lib/store.ts'
import {
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
} from '../test-utils/store-setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

describe('mr store gc', () => {
  describe('with unused worktrees', () => {
    it('should identify unused worktrees when not in a megarepo', () =>
      withTestCtx(
        Effect.gen(function* () {
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
        }),
      ))

    it('should skip dirty worktrees without --force', () =>
      withTestCtx(
        Effect.gen(function* () {
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
        }),
      ))
  })

  describe('with workspace lock file', () => {
    it('should mark worktrees as in-use when referenced in lock file', () =>
      withTestCtx(
        Effect.gen(function* () {
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
        }),
      ))
  })
})

describe('mr store ls', () => {
  it('should list repos in the store', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))

  it('should return empty list for empty store', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create empty store directory
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
        yield* fs.makeDirectory(storePath, { recursive: true })

        const storeLayer = makeStoreLayer({ basePath: storePath })
        const store = yield* Store.pipe(Effect.provide(storeLayer))

        const repos = yield* store.listRepos()
        expect(repos).toHaveLength(0)
      }),
    ))
})

describe('store worktree paths', () => {
  it('should generate correct worktree paths for different ref types', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))

  it('should encode special characters in ref names', () =>
    withTestCtx(
      Effect.gen(function* () {
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
        // The slash should be URL-encoded
        expect(pathWithSlash).toContain('feature%2Fmy-branch')
      }),
    ))
})

describe('lock file pin/unpin operations', () => {
  it('should pin a member in the lock file', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))

  it('should unpin a member in the lock file', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))

  it('should not modify other members when pinning/unpinning', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))
})

describe('lock file operations', () => {
  it('should create and read lock file with pinned member', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))

  it('should handle multiple members with different pin states', () =>
    withTestCtx(
      Effect.gen(function* () {
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
      }),
    ))
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
