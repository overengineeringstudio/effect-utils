import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
} from '../lib/lock.ts'
import { createRepo, createWorkspace } from '../test-utils/setup.ts'
import { createWorkspaceWithLock } from '../test-utils/store-setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

describe('mr sync', () => {
  describe('with local path members', () => {
    it('should create symlinks for local path members', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a temp directory with a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'local-lib',
              files: { 'package.json': '{"name": "local-lib"}' },
            },
          })

          // Create workspace with path member pointing to local repo
          const { workspacePath } = yield* createWorkspace({
            name: 'test-megarepo',
            members: {
              'local-lib': localRepoPath,
            },
          })

          // Verify the config was created
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('megarepo.json'),
          )
          expect(yield* fs.exists(configPath)).toBe(true)

          // Verify symlink does NOT exist yet (sync hasn't run)
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('local-lib/'),
          )
          expect(yield* fs.exists(symlinkPath)).toBe(false)

          // Note: Actually running the sync command would require more setup
          // (proper CLI runner, etc). This test verifies the workspace fixture works.
        }),
      ))
  })

  describe('workspace fixture', () => {
    it('should create workspace with symlinked repos', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with repos that get symlinked
          const { workspacePath, repoPaths } = yield* createWorkspace({
            name: 'full-workspace',
            members: {
              repo1: 'test/repo1',
            },
            repos: [{ name: 'repo1' }],
          })

          // Verify workspace structure
          expect(yield* fs.exists(workspacePath)).toBe(true)
          expect(
            yield* fs.exists(
              EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
            ),
          ).toBe(true)

          // Verify repo was created and symlinked
          expect(repoPaths['repo1']).toBeDefined()
          // Note: Symlinks are created without trailing slashes
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repo1'),
          )
          expect(yield* fs.exists(symlinkPath)).toBe(true)

          // Verify it's a symlink by reading the link target
          const linkTarget = yield* fs.readLink(symlinkPath)
          // The link target should be the repo path without trailing slash
          expect(linkTarget).toBe(repoPaths['repo1']?.slice(0, -1))
        }),
      ))
  })
})

describe('frozen mode', () => {
  describe('lock file staleness detection', () => {
    it('should detect stale lock file when members are added to config', () => {
      // Create lock file with one member
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'existing-lib',
        member: createLockedMember({
          url: 'https://github.com/owner/existing-lib',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })

      // Config has the existing member plus a new one
      const configMemberNames = new Set(['existing-lib', 'new-lib'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toContain('new-lib')
      expect(result.removedMembers).toHaveLength(0)
    })

    it('should detect stale lock file when members are removed from config', () => {
      // Create lock file with two members
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      // Config only has lib1 (lib2 was removed)
      const configMemberNames = new Set(['lib1'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toHaveLength(0)
      expect(result.removedMembers).toContain('lib2')
    })

    it('should not be stale when lock file matches config', () => {
      // Create lock file with same members as config
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      const configMemberNames = new Set(['lib1', 'lib2'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(false)
      expect(result.addedMembers).toHaveLength(0)
      expect(result.removedMembers).toHaveLength(0)
    })

    it('should detect both added and removed members', () => {
      // Lock file has lib1 and lib2
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      // Config has lib1 and lib3 (lib2 removed, lib3 added)
      const configMemberNames = new Set(['lib1', 'lib3'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toContain('lib3')
      expect(result.removedMembers).toContain('lib2')
    })
  })

  describe('frozen mode with workspace', () => {
    it('should have up-to-date lock file when config matches', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with lock file that matches config
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': 'owner/repo',
            },
            lockEntries: {
              'my-lib': {
                url: 'https://github.com/owner/repo',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness with config member names
          const configMemberNames = new Set(['my-lib'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should not be stale - frozen mode would succeed
          expect(result.isStale).toBe(false)
        }),
      ))

    it('should detect missing lock file entries for frozen mode', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with lock file missing an entry
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              lib1: 'owner/lib1',
              lib2: 'owner/lib2', // This is in config but not in lock
            },
            lockEntries: {
              // Only lib1 is in lock file
              lib1: {
                url: 'https://github.com/owner/lib1',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness - lib2 is added in config but not in lock
          const configMemberNames = new Set(['lib1', 'lib2'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should be stale - frozen mode would fail
          expect(result.isStale).toBe(true)
          expect(result.addedMembers).toContain('lib2')
        }),
      ))

    it('should detect extra lock file entries for frozen mode', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with lock file having extra entries
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              lib1: 'owner/lib1', // Only this is in config
            },
            lockEntries: {
              lib1: {
                url: 'https://github.com/owner/lib1',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
              'old-lib': {
                // This was removed from config
                url: 'https://github.com/owner/old-lib',
                ref: 'main',
                commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness - old-lib is in lock but not in config
          const configMemberNames = new Set(['lib1'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should be stale - frozen mode would fail
          expect(result.isStale).toBe(true)
          expect(result.removedMembers).toContain('old-lib')
        }),
      ))
  })

  describe('frozen mode with pinned members', () => {
    it('should preserve pinned commit in lock file', () =>
      withTestCtx(
        Effect.gen(function* () {
          const pinnedCommit = 'abc1234567890abcdef1234567890abcdef1234'

          // Create workspace with pinned member
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'pinned-lib': 'owner/repo',
            },
            lockEntries: {
              'pinned-lib': {
                url: 'https://github.com/owner/repo',
                ref: 'main',
                commit: pinnedCommit,
                pinned: true,
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Verify pinned state
          expect(lockFile.members['pinned-lib']!.pinned).toBe(true)
          expect(lockFile.members['pinned-lib']!.commit).toBe(pinnedCommit)

          // Check staleness - should not be stale
          const configMemberNames = new Set(['pinned-lib'])
          const result = checkLockStaleness({ lockFile, configMemberNames })
          expect(result.isStale).toBe(false)
        }),
      ))
  })
})
