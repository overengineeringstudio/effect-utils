/**
 * Pin Command Integration Tests
 *
 * Tests for the `mr pin` command logic, including the -c flag for switching refs.
 * These tests use direct function calls instead of CLI subprocess to avoid timeouts.
 */

import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  buildSourceStringWithRef,
  CONFIG_FILE_NAME,
  MegarepoConfig,
  parseSourceString,
} from '../lib/config.ts'
import {
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
  writeLockFile,
  type LockFile,
} from '../lib/lock.ts'
import { classifyRef } from '../lib/ref.ts'
import { addCommit, initGitRepo, readConfig, runGitCommand } from '../test-utils/setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

/**
 * Create a minimal test setup for pin command testing.
 */
const createMinimalTestSetup = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory structure
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const workspacePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('workspace/'))

    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize workspace as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: typeof MegarepoConfig.Type = {
      members: {
        'test-repo': 'test-owner/test-repo',
      },
    }
    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      config,
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )
    yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

    return {
      tmpDir,
      workspacePath,
    }
  })

describe('mr pin', () => {
  describe('config update logic', () => {
    it('should update megarepo.json when switching refs', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          // Read initial config
          const initialConfig = yield* readConfig(workspacePath)
          expect(initialConfig.members['test-repo']).toBe('test-owner/test-repo')

          // Simulate what pin -c does: update the config
          const newRef = 'feature-branch'
          const oldSourceString = initialConfig.members['test-repo']!
          const newSourceString = buildSourceStringWithRef({
            sourceString: oldSourceString,
            newRef,
          })

          const updatedConfig = {
            ...initialConfig,
            members: {
              ...initialConfig.members,
              'test-repo': newSourceString,
            },
          }

          // Write updated config
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const newConfigContent = yield* Schema.encode(
            Schema.parseJson(MegarepoConfig, { space: 2 }),
          )(updatedConfig)
          yield* fs.writeFileString(configPath, newConfigContent + '\n')

          // Verify the update
          const finalConfig = yield* readConfig(workspacePath)
          expect(finalConfig.members['test-repo']).toBe('test-owner/test-repo#feature-branch')
        }),
      ))

    it('should replace existing ref when switching', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          // First update to feature-branch
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )

          const config1: typeof MegarepoConfig.Type = {
            members: {
              'test-repo': 'test-owner/test-repo#feature-branch',
            },
          }
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config1)) + '\n',
          )

          // Now switch to main
          const newSourceString = buildSourceStringWithRef({
            sourceString: config1.members['test-repo']!,
            newRef: 'main',
          })
          expect(newSourceString).toBe('test-owner/test-repo#main')

          // Verify the source was updated correctly (replaced, not appended)
          const source = parseSourceString(newSourceString)
          expect(source?.type).toBe('github')
          if (source?.type === 'github') {
            expect(Option.getOrNull(source.ref)).toBe('main')
          }
        }),
      ))
  })

  describe('lock file update logic', () => {
    it('should create lock entry with pinned=true when using -c', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Simulate what pin -c does: create/update lock file
          const newRef = 'feature-branch'
          const commit = 'abc123def456789012345678901234567890abcd'

          const lockFile: LockFile = {
            version: 1,
            members: {},
          }

          const updatedLockFile = updateLockedMember({
            lockFile,
            memberName: 'test-repo',
            member: createLockedMember({
              url: 'https://github.com/test-owner/test-repo',
              ref: newRef,
              commit,
              pinned: true,
            }),
          })

          yield* writeLockFile({ lockPath, lockFile: updatedLockFile })

          // Read and verify
          const savedLockFile = yield* readLockFile(lockPath)
          expect(Option.isSome(savedLockFile)).toBe(true)
          if (Option.isSome(savedLockFile)) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(commit)
            expect(member?.pinned).toBe(true)
          }
        }),
      ))

    it('should update existing lock entry when switching refs', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Create initial lock file
          const initialCommit = 'abc123def456789012345678901234567890abcd'
          const initialLockFile: LockFile = {
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://github.com/test-owner/test-repo',
                ref: 'main',
                commit: initialCommit,
                pinned: false,
              }),
            },
          }
          yield* writeLockFile({ lockPath, lockFile: initialLockFile })

          // Switch to feature branch
          const newCommit = 'def456abc789012345678901234567890abcdef12'
          const updatedLockFile = updateLockedMember({
            lockFile: initialLockFile,
            memberName: 'test-repo',
            member: createLockedMember({
              url: 'https://github.com/test-owner/test-repo',
              ref: 'feature-branch',
              commit: newCommit,
              pinned: true,
            }),
          })
          yield* writeLockFile({ lockPath, lockFile: updatedLockFile })

          // Verify update
          const savedLockFile = yield* readLockFile(lockPath)
          expect(Option.isSome(savedLockFile)).toBe(true)
          if (Option.isSome(savedLockFile)) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(newCommit)
            expect(member?.pinned).toBe(true)
          }
        }),
      ))
  })

  describe('ref classification for worktree paths', () => {
    it('should classify branches correctly', () => {
      expect(classifyRef('main')).toBe('branch')
      expect(classifyRef('feature/foo')).toBe('branch')
      expect(classifyRef('develop')).toBe('branch')
      expect(classifyRef('release-candidate')).toBe('branch')
    })

    it('should classify tags correctly', () => {
      expect(classifyRef('v1.0.0')).toBe('tag')
      expect(classifyRef('v2.0')).toBe('tag')
      expect(classifyRef('1.0.0')).toBe('tag')
      expect(classifyRef('release-v1.0.0')).toBe('tag')
    })

    it('should classify commits correctly', () => {
      expect(classifyRef('abc123def456789012345678901234567890abcd')).toBe('commit')
    })
  })

  describe('source string manipulation', () => {
    it('should build correct source strings for different refs', () => {
      const base = 'test-owner/test-repo'

      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'main' })).toBe(
        'test-owner/test-repo#main',
      )
      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'v1.0.0' })).toBe(
        'test-owner/test-repo#v1.0.0',
      )
      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'feature/foo' })).toBe(
        'test-owner/test-repo#feature/foo',
      )
      expect(
        buildSourceStringWithRef({
          sourceString: base,
          newRef: 'abc123def456789012345678901234567890abcd',
        }),
      ).toBe('test-owner/test-repo#abc123def456789012345678901234567890abcd')
    })

    it('should handle switching from one ref to another', () => {
      const withRef = 'test-owner/test-repo#old-branch'

      expect(buildSourceStringWithRef({ sourceString: withRef, newRef: 'new-branch' })).toBe(
        'test-owner/test-repo#new-branch',
      )
      expect(buildSourceStringWithRef({ sourceString: withRef, newRef: 'v2.0.0' })).toBe(
        'test-owner/test-repo#v2.0.0',
      )
    })
  })
})
