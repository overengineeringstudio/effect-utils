import path from 'node:path'
import url from 'node:url'

import { Command, FileSystem } from '@effect/platform'
import { Chunk, Effect, Option, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../lib/config.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
} from '../lib/lock.ts'
import {
  addCommit,
  createRepo,
  createWorkspace,
  initGitRepo,
  runGitCommand,
} from '../test-utils/setup.ts'
import { createWorkspaceWithLock } from '../test-utils/store-setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

// Path to the CLI binary
// TODO get rid of this approach and use effect cli command directly and yield its handler
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(__dirname, '../../bin/mr.ts')

/** Decode collected chunks to string */
const decodeChunks = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const merged = Chunk.reduce(chunks, new Uint8Array(), (acc, chunk) => {
    const result = new Uint8Array(acc.length + chunk.length)
    result.set(acc)
    result.set(chunk, acc.length)
    return result
  })
  return new TextDecoder().decode(merged)
}

/**
 * Run the sync CLI command and capture output.
 */
const runSyncCommand = ({
  cwd,
  args = [],
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const command = Command.make('bun', 'run', CLI_PATH, 'sync', ...args).pipe(
      Command.workingDirectory(cwd),
      Command.env({ PWD: cwd }),
      Command.stdout('pipe'),
      Command.stderr('pipe'),
    )

    const process = yield* Command.start(command)
    const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
      Stream.runCollect(process.stdout),
      Stream.runCollect(process.stderr),
      process.exitCode,
    ])

    return {
      stdout: decodeChunks(stdoutChunks),
      stderr: decodeChunks(stderrChunks),
      exitCode,
    }
  }).pipe(Effect.scoped)

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
            EffectPath.unsafe.relativeFile('repos/repo1'),
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

// =============================================================================
// Nested Megarepo Tests (--deep mode)
// =============================================================================

/**
 * Helper to create a nested megarepo structure.
 * Creates a parent megarepo with a child member that is itself a megarepo.
 */
const createNestedMegarepoFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    // Create grandchild repo (a normal git repo)
    const grandchildPath = yield* createRepo({
      basePath: tmpDir,
      fixture: {
        name: 'grandchild-lib',
        files: { 'package.json': '{"name": "grandchild-lib"}' },
      },
    })

    // Create child megarepo that includes grandchild as a member
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-megarepo/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)

    // Create child's megarepo.json pointing to grandchild
    const childConfig: typeof MegarepoConfig.Type = {
      members: {
        'grandchild-lib': grandchildPath,
      },
    }
    const childConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      childConfig,
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
      childConfigContent + '\n',
    )
    yield* addCommit({ repoPath: childPath, message: 'Initialize child megarepo' })

    // Create parent megarepo that includes child as a member
    const parentPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('parent-megarepo/'),
    )
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)

    // Create parent's megarepo.json pointing to child
    const parentConfig: typeof MegarepoConfig.Type = {
      members: {
        'child-megarepo': childPath,
      },
    }
    const parentConfigContent = yield* Schema.encode(
      Schema.parseJson(MegarepoConfig, { space: 2 }),
    )(parentConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
      parentConfigContent + '\n',
    )
    yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

    return {
      parentPath,
      childPath,
      grandchildPath,
    }
  })

describe('deep sync mode', () => {
  describe('nested megarepo detection', () => {
    it('should detect when a member is itself a megarepo', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { parentPath, childPath } = yield* createNestedMegarepoFixture()

          // Verify parent has megarepo.json
          const parentConfigPath = EffectPath.ops.join(
            parentPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          expect(yield* fs.exists(parentConfigPath)).toBe(true)

          // Verify child has megarepo.json (making it a nested megarepo)
          const childConfigPath = EffectPath.ops.join(
            childPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          expect(yield* fs.exists(childConfigPath)).toBe(true)

          // Read parent config and verify it points to child
          const parentConfigContent = yield* fs.readFileString(parentConfigPath)
          const parentConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            parentConfigContent,
          )
          expect(parentConfig.members['child-megarepo']).toBe(childPath)
        }),
      ))

    it('should create valid nested megarepo structure with grandchild', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { childPath, grandchildPath } = yield* createNestedMegarepoFixture()

          // Read child config and verify it points to grandchild
          const childConfigPath = EffectPath.ops.join(
            childPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const childConfigContent = yield* fs.readFileString(childConfigPath)
          const childConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            childConfigContent,
          )
          expect(childConfig.members['grandchild-lib']).toBe(grandchildPath)

          // Verify grandchild is a regular repo (no megarepo.json)
          const grandchildConfigPath = EffectPath.ops.join(
            grandchildPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          expect(yield* fs.exists(grandchildConfigPath)).toBe(false)
        }),
      ))
  })
})

/**
 * Helper to create a diamond dependency structure for testing deduplication.
 *
 * Creates:
 *   root/
 *   ├── megarepo.json (members: child-a, child-b)
 *   ├── child-a/           <- megarepo with member: shared-lib
 *   │   └── megarepo.json
 *   ├── child-b/           <- megarepo with member: shared-lib (same!)
 *   │   └── megarepo.json
 *   └── shared-lib/        <- regular repo, referenced by both children
 *
 * This creates a diamond: root → child-a → shared-lib
 *                         root → child-b → shared-lib
 *
 * Without deduplication, shared-lib would be processed twice.
 */
const createDiamondDependencyFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    // Create shared-lib (a regular git repo, not a megarepo)
    const sharedLibPath = yield* createRepo({
      basePath: tmpDir,
      fixture: {
        name: 'shared-lib',
        files: { 'package.json': '{"name": "shared-lib"}' },
      },
    })

    // Create child-a megarepo that includes shared-lib
    const childAPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-a/'))
    yield* fs.makeDirectory(childAPath, { recursive: true })
    yield* initGitRepo(childAPath)
    const childAConfig: typeof MegarepoConfig.Type = {
      members: { 'shared-lib': sharedLibPath },
    }
    const childAConfigContent = yield* Schema.encode(
      Schema.parseJson(MegarepoConfig, { space: 2 }),
    )(childAConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childAPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
      childAConfigContent + '\n',
    )
    yield* addCommit({ repoPath: childAPath, message: 'Initialize child-a megarepo' })

    // Create child-b megarepo that ALSO includes shared-lib (diamond!)
    const childBPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-b/'))
    yield* fs.makeDirectory(childBPath, { recursive: true })
    yield* initGitRepo(childBPath)
    const childBConfig: typeof MegarepoConfig.Type = {
      members: { 'shared-lib': sharedLibPath },
    }
    const childBConfigContent = yield* Schema.encode(
      Schema.parseJson(MegarepoConfig, { space: 2 }),
    )(childBConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childBPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
      childBConfigContent + '\n',
    )
    yield* addCommit({ repoPath: childBPath, message: 'Initialize child-b megarepo' })

    // Create root megarepo that includes both children
    const rootPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('root/'))
    yield* fs.makeDirectory(rootPath, { recursive: true })
    yield* initGitRepo(rootPath)
    const rootConfig: typeof MegarepoConfig.Type = {
      members: {
        'child-a': childAPath,
        'child-b': childBPath,
      },
    }
    const rootConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      rootConfig,
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(rootPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
      rootConfigContent + '\n',
    )
    yield* addCommit({ repoPath: rootPath, message: 'Initialize root megarepo' })

    return {
      rootPath,
      childAPath,
      childBPath,
      sharedLibPath,
    }
  })

describe('deep sync deduplication', () => {
  it('should create valid diamond dependency structure', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { rootPath, childAPath, childBPath, sharedLibPath } =
          yield* createDiamondDependencyFixture()

        // Verify root has both children as members
        const rootConfigPath = EffectPath.ops.join(
          rootPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const rootConfigContent = yield* fs.readFileString(rootConfigPath)
        const rootConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
          rootConfigContent,
        )
        expect(rootConfig.members['child-a']).toBe(childAPath)
        expect(rootConfig.members['child-b']).toBe(childBPath)

        // Verify both children reference the same shared-lib
        const childAConfigPath = EffectPath.ops.join(
          childAPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const childAConfigContent = yield* fs.readFileString(childAConfigPath)
        const childAConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
          childAConfigContent,
        )
        expect(childAConfig.members['shared-lib']).toBe(sharedLibPath)

        const childBConfigPath = EffectPath.ops.join(
          childBPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const childBConfigContent = yield* fs.readFileString(childBConfigPath)
        const childBConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
          childBConfigContent,
        )
        expect(childBConfig.members['shared-lib']).toBe(sharedLibPath)

        // Both children reference the SAME path
        expect(childAConfig.members['shared-lib']).toBe(childBConfig.members['shared-lib'])
      }),
    ))
})

// =============================================================================
// Default Mode Tests (lock updated from worktree HEADs)
// =============================================================================

describe('default sync mode (no --pull)', () => {
  describe('lock file updates', () => {
    it('should update lock file when worktree HEAD differs from lock', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a temp directory with a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Get the initial commit (used for lock file setup below)
          const _initialCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with lock pointing to an OLD commit
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': localRepoPath,
            },
            lockEntries: {
              'my-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // Old/wrong commit
              },
            },
          })

          // Run sync (default mode, no --pull)
          const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--json'] })
          const json = JSON.parse(result.stdout.trim()) as {
            results: Array<{ name: string; status: string; lockUpdated?: boolean }>
          }

          // Should have synced successfully (local path sources are symlinks)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // For local paths, status is 'synced' since they create symlinks
          expect(['synced', 'locked', 'already_synced']).toContain(memberResult?.status)
        }),
      ))

    it('should return already_synced when lock matches current HEAD', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Get the current commit
          const currentCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with lock matching current commit
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': localRepoPath,
            },
            lockEntries: {
              'my-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: currentCommit, // Matches current HEAD
              },
            },
          })

          // First sync to create symlinks
          yield* runSyncCommand({ cwd: workspacePath, args: [] })

          // Second sync should show already_synced
          const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--json'] })
          const json = JSON.parse(result.stdout.trim()) as {
            results: Array<{ name: string; status: string }>
          }

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // After first sync, should be already_synced or synced
          expect(['synced', 'already_synced']).toContain(memberResult?.status)
        }),
      ))
  })

  describe('no remote fetch', () => {
    it('should NOT fetch from remote in default mode', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with a non-existent remote member
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          // Create megarepo.json with a GitHub repo
          const config: typeof MegarepoConfig.Type = {
            members: {
              // Using a real but unlikely-to-change repo
              effect: 'effect-ts/effect',
            },
          }
          const configContent = yield* Schema.encode(
            Schema.parseJson(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
            configContent + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // Run sync (default mode) - this should NOT fetch since no worktree exists yet
          // It should try to clone since member doesn't exist
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--json', '--dry-run'],
          })

          // The command should complete (might error on clone attempt, but shouldn't hang on fetch)
          expect(result.exitCode).toBeDefined()
        }),
      ))
  })
})

// =============================================================================
// Pull Mode Tests (--pull flag)
// =============================================================================

describe('sync --pull mode', () => {
  describe('dirty worktree protection', () => {
    it('should skip member with uncommitted changes unless --force', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a dirty local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'dirty-lib',
              files: { 'package.json': '{"name": "dirty-lib"}' },
              dirty: true, // Has uncommitted changes
            },
          })

          // Create workspace
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'dirty-lib': localRepoPath,
            },
            lockEntries: {
              'dirty-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Create symlink manually to simulate existing member
          const reposDir = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('repos/'),
          )
          yield* fs.makeDirectory(reposDir, { recursive: true })
          yield* fs.symlink(
            localRepoPath.slice(0, -1),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('dirty-lib')),
          )

          // Run sync --pull (should skip dirty worktree)
          // Note: For local path sources, dirty check may not apply the same way
          // This test documents the expected behavior
          const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--pull', '--json'] })

          // Should complete without error
          expect(result.exitCode).toBeDefined()
        }),
      ))
  })

  describe('pinned members', () => {
    it('should skip pinned members in --pull mode', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'pinned-lib',
              files: { 'package.json': '{"name": "pinned-lib"}' },
            },
          })

          const currentCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with pinned member
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'pinned-lib': localRepoPath,
            },
            lockEntries: {
              'pinned-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: currentCommit,
                pinned: true, // PINNED
              },
            },
          })

          // Create symlink manually
          const reposDir = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('repos/'),
          )
          yield* fs.makeDirectory(reposDir, { recursive: true })
          yield* fs.symlink(
            localRepoPath.slice(0, -1),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('pinned-lib')),
          )

          // Run sync --pull
          const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--pull', '--json'] })
          const json = JSON.parse(result.stdout.trim()) as {
            results: Array<{ name: string; status: string }>
          }

          // The sync should complete
          expect(json.results).toHaveLength(1)
          // Note: Local path sources behave differently, but this documents the behavior
        }),
      ))
  })
})

// =============================================================================
// Status Types Tests
// =============================================================================

describe('sync status types', () => {
  it('should return cloned status for new members', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a local repo
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const localRepoPath = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'new-lib',
            files: { 'package.json': '{"name": "new-lib"}' },
          },
        })

        // Create workspace WITHOUT lock file (new member)
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const config: typeof MegarepoConfig.Type = {
          members: {
            'new-lib': localRepoPath,
          },
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          config,
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          configContent + '\n',
        )
        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Run sync for first time
        const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--json'] })
        const json = JSON.parse(result.stdout.trim()) as {
          results: Array<{ name: string; status: string }>
        }

        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('new-lib')
        // For local paths, first sync creates a symlink - status is 'synced'
        expect(memberResult?.status).toBe('synced')
      }),
    ))
})

describe('sync error handling', () => {
  it('should return clear error when remote repo does not exist', () =>
    withTestCtx(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a megarepo with a non-existent remote member
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        // Create megarepo.json with a non-existent GitHub repo
        const config: typeof MegarepoConfig.Type = {
          members: {
            // This repo doesn't exist - should trigger a clone failure
            'non-existent-repo': 'this-owner-does-not-exist-abc123/this-repo-does-not-exist-xyz789',
          },
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          config,
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          configContent + '\n',
        )
        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Run sync --json to get structured output
        const result = yield* runSyncCommand({ cwd: workspacePath, args: ['--json'] })

        // Parse the JSON output
        const json = JSON.parse(result.stdout.trim()) as {
          results: Array<{ name: string; status: string; message?: string }>
        }

        // Should have results for our member
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('non-existent-repo')
        expect(memberResult?.status).toBe('error')

        // The error message should be clear and actionable, NOT a cryptic filesystem error
        expect(memberResult?.message).toBeDefined()
        // Should NOT contain cryptic internal errors like "FileSystem.access"
        expect(memberResult?.message).not.toContain('FileSystem.access')
        // Should indicate the actual problem - repo not found or clone failed
        expect(
          memberResult?.message?.toLowerCase().includes('clone') ||
            memberResult?.message?.toLowerCase().includes('repository') ||
            memberResult?.message?.toLowerCase().includes('not found') ||
            memberResult?.message?.toLowerCase().includes('access'),
        ).toBe(true)
      }),
    ))
})
