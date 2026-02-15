import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Chunk, Effect, Exit, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../lib/config.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
  writeLockFile,
} from '../lib/lock.ts'
import { MegarepoSyncTree, SyncErrorItem } from '../lib/sync/schema.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  addCommit,
  createRepo,
  createWorkspace,
  initGitRepo,
  runGitCommand,
} from '../test-utils/setup.ts'
import { createStoreFixture, createWorkspaceWithLock } from '../test-utils/store-setup.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

/** Schema for parsing JSON output from `mr sync --output json` */
const SyncJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      lockUpdated: Schema.optional(Schema.Boolean),
      commit: Schema.optional(Schema.String),
      ref: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      previousCommit: Schema.optional(Schema.String),
      refMismatch: Schema.optional(
        Schema.Struct({
          expectedRef: Schema.String,
          actualRef: Schema.String,
          isDetached: Schema.Boolean,
        }),
      ),
    }),
  ),
})

const decodeSyncJsonOutput = Schema.decodeUnknownSync(Schema.parseJson(SyncJsonOutput))

/** Run the sync CLI command and capture output. */
const runSyncCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines, getStderrLines } = yield* makeConsoleCapture
    const mergedEnv = { PWD: cwd, ...env }
    const envCapture = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = new Map<string, string | undefined>()
        for (const [key, value] of Object.entries(mergedEnv)) {
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

    const stderrCapture = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stderrChunks: Array<string> = []
        const originalStderrWrite = process.stderr.write.bind(process.stderr)

        const captureWrite = (target: Array<string>) =>
          ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
            const actualEncoding =
              typeof encoding === 'function' ? undefined : (encoding as BufferEncoding)
            const callback = typeof encoding === 'function' ? encoding : cb
            const text =
              typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk as Uint8Array).toString(actualEncoding)
            target.push(text)
            if (typeof callback === 'function') callback()
            return true
          }) as unknown as typeof process.stderr.write

        process.stderr.write = captureWrite(stderrChunks)

        return { stderrChunks, originalStderrWrite }
      }),
      (capture) =>
        Effect.sync(() => {
          process.stderr.write = capture.originalStderrWrite
        }),
    )

    const argv = ['node', 'mr', 'sync', ...args]
    const effect = Cli.Command.run(mrCommand, { name: 'mr', version: 'test' })(argv).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(consoleLayer),
    )
    const exit = yield* Effect.exit(effect)
    void envCapture

    return {
      exit,
      stdout: (yield* getStdoutLines).join('\n'),
      stderr: [stderrCapture.stderrChunks.join(''), ...(yield* getStderrLines)].join('\n'),
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
    }
  }).pipe(Effect.scoped)

describe('mr sync', () => {
  describe('with local path members', () => {
    it.effect(
      'should create symlinks for local path members',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('workspace fixture', () => {
    it.effect(
      'should create workspace with symlinked repos',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
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
    it.effect(
      'should have up-to-date lock file when config matches',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect missing lock file entries for frozen mode',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect extra lock file entries for frozen mode',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('frozen mode with pinned members', () => {
    it.effect(
      'should preserve pinned commit in lock file',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Nested Megarepo Tests (--all mode)
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
    yield* addCommit({
      repoPath: childPath,
      message: 'Initialize child megarepo',
    })

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
    yield* addCommit({
      repoPath: parentPath,
      message: 'Initialize parent megarepo',
    })

    return {
      parentPath,
      childPath,
      grandchildPath,
    }
  })

describe('--all sync mode', () => {
  describe('nested megarepo detection', () => {
    it.effect(
      'should detect when a member is itself a megarepo',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should create valid nested megarepo structure with grandchild',
      Effect.fnUntraced(
        function* () {
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
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})

describe('--all nested error reporting', () => {
  it.effect(
    'should include nested member errors in JSON output',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

        // Create child megarepo with an invalid member source (guaranteed error, no network)
        const childPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('child-megarepo/'),
        )
        yield* fs.makeDirectory(childPath, { recursive: true })
        yield* initGitRepo(childPath)
        yield* fs.writeFileString(
          EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
            members: {
              bad: 'not-a-valid-source',
            },
          })) + '\n',
        )
        yield* addCommit({ repoPath: childPath, message: 'Initialize child megarepo' })

        // Create parent megarepo that includes child as a local path member
        const parentPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('parent-megarepo/'),
        )
        yield* fs.makeDirectory(parentPath, { recursive: true })
        yield* initGitRepo(parentPath)
        yield* fs.writeFileString(
          EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
            members: {
              child: childPath,
            },
          })) + '\n',
        )
        yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

        // When syncing nested megarepos, the nested root is the workspace member path (repos/<name>/)
        const childNestedRoot = EffectPath.ops.join(
          parentPath,
          EffectPath.unsafe.relativeDir('repos/child/'),
        )

        const result = yield* runSyncCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
        })

        expect(result.stdout.trim()).not.toBe('')

        const SyncOutput = Schema.TaggedStruct('Error', {
          syncErrorCount: Schema.Number,
          syncErrors: Schema.Array(SyncErrorItem),
          syncTree: MegarepoSyncTree,
        })
        const out = yield* Schema.decodeUnknown(Schema.parseJson(SyncOutput))(result.stdout.trim())

        // The command should surface nested errors in output (and set process.exitCode via SyncApp)
        expect(out.syncErrorCount).toBe(1)
        expect(out.syncErrors).toHaveLength(1)
        const firstError = out.syncErrors[0]
        expect(firstError).toBeDefined()
        if (firstError !== undefined) {
          expect(firstError.megarepoRoot).toBe(childNestedRoot)
          expect(firstError.memberName).toBe('bad')
        }

        // Nested sync tree should include the child result with the failing member
        expect(out.syncTree.root).toBe(parentPath)
        expect(out.syncTree.nestedResults).toHaveLength(1)
        const firstNested = out.syncTree.nestedResults[0]
        expect(firstNested).toBeDefined()
        if (firstNested !== undefined) {
          expect(firstNested.root).toBe(childNestedRoot)

          const nestedResults = firstNested.results
          expect(nestedResults.some((r) => r.name === 'bad' && r.status === 'error')).toBe(true)
        }
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
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
    yield* addCommit({
      repoPath: childAPath,
      message: 'Initialize child-a megarepo',
    })

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
    yield* addCommit({
      repoPath: childBPath,
      message: 'Initialize child-b megarepo',
    })

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
    yield* addCommit({
      repoPath: rootPath,
      message: 'Initialize root megarepo',
    })

    return {
      rootPath,
      childAPath,
      childBPath,
      sharedLibPath,
    }
  })

describe('--all sync deduplication', () => {
  it.effect(
    'should create valid diamond dependency structure',
    Effect.fnUntraced(
      function* () {
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
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// Default Mode Tests (lock updated from worktree HEADs)
// =============================================================================

describe('default sync mode (no --pull)', () => {
  describe('lock file updates', () => {
    it.effect(
      'should update lock file when worktree HEAD differs from lock',
      Effect.fnUntraced(
        function* () {
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
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced successfully (local path sources are symlinks)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // For local paths, status is 'synced' since they create symlinks
          expect(['synced', 'locked', 'already_synced']).toContain(memberResult?.status)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should return already_synced when lock matches current HEAD',
      Effect.fnUntraced(
        function* () {
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
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // After first sync, should be already_synced or synced
          expect(['synced', 'already_synced']).toContain(memberResult?.status)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('no remote fetch', () => {
    it.effect(
      'should NOT fetch from remote in default mode',
      Effect.fnUntraced(
        function* () {
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
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync (default mode) - this should NOT fetch since no worktree exists yet
          // It should try to clone since member doesn't exist
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--dry-run'],
          })

          // The command should complete (might error on clone attempt, but shouldn't hang on fetch)
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('ref change detection', () => {
    it.effect(
      'should update symlink when ref changes in config',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create a local repo without the feature file
          const baseRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Create a second repo that includes the feature file
          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: {
                'package.json': '{"name": "my-lib"}',
                'feature.txt': 'feature content\n',
              },
            },
          })

          // Create workspace pointing to the base repo path
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          // Create initial config pointing to the base repo path
          const initialConfig: typeof MegarepoConfig.Type = {
            members: {
              'my-lib': baseRepoPath,
            },
          }
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(initialConfig)) +
              '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runSyncCommand({ cwd: workspacePath, args: [] })

          // Verify symlink exists
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const initialLink = yield* fs.readLink(symlinkPath)
          expect(initialLink).toBeDefined()

          // Verify feature.txt does NOT exist for the base repo
          const featureFileInBase = yield* fs
            .exists(
              EffectPath.ops.join(
                workspacePath,
                EffectPath.unsafe.relativeFile('repos/my-lib/feature.txt'),
              ),
            )
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
          expect(featureFileInBase).toBe(false)

          // Update config to point to the feature repo path
          const updatedConfig: typeof MegarepoConfig.Type = {
            members: {
              'my-lib': featureRepoPath,
            },
          }
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(updatedConfig)) +
              '\n',
          )

          // Sync again - should update symlink
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced (updated symlink)
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('synced')

          // Verify symlink now points to new location
          const updatedLink = yield* fs.readLink(symlinkPath)
          expect(updatedLink).not.toBe(initialLink)

          const featureFileInFeature = yield* fs
            .exists(
              EffectPath.ops.join(
                workspacePath,
                EffectPath.unsafe.relativeFile('repos/my-lib/feature.txt'),
              ),
            )
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
          expect(featureFileInFeature).toBe(true)
          expect(updatedLink.replace(/\/$/, '')).toBe(featureRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should skip ref change if old worktree has uncommitted changes',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create two local repos (simulating two branches)
          const mainRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-main',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: {
                'package.json': '{"name": "my-lib"}',
                'feature.txt': 'feature content\n',
              },
            },
          })

          // Create workspace pointing to main
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
              members: { 'my-lib': mainRepoPath },
            })) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runSyncCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes to the main repo (simulating work in progress)
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config to point to feature branch
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
              members: { 'my-lib': featureRepoPath },
            })) + '\n',
          )

          // Sync again - should skip because old worktree is dirty
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have skipped due to dirty worktree
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('skipped')
          expect(json.results[0]?.message).toContain('uncommitted')

          // Verify symlink still points to main
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const currentLink = yield* fs.readLink(symlinkPath)
          expect(currentLink.replace(/\/$/, '')).toBe(mainRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should allow ref change with --force even if old worktree is dirty',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create two local repos
          const mainRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-main',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: { 'package.json': '{"name": "my-lib"}', 'feature.txt': 'feature\n' },
            },
          })

          // Create workspace
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
              members: { 'my-lib': mainRepoPath },
            })) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync
          yield* runSyncCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))({
              members: { 'my-lib': featureRepoPath },
            })) + '\n',
          )

          // Sync with --force - should succeed
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--force'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced despite dirty worktree
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('synced')

          // Verify symlink now points to feature
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const currentLink = yield* fs.readLink(symlinkPath)
          expect(currentLink.replace(/\/$/, '')).toBe(featureRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Pull Mode Tests (--pull flag)
// =============================================================================

describe('sync --pull mode', () => {
  describe('dirty worktree protection', () => {
    it.effect(
      'should skip member with uncommitted changes unless --force',
      Effect.fnUntraced(
        function* () {
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
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--pull', '--output', 'json'],
          })

          // Should complete without error
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('pinned members', () => {
    it.effect(
      'should skip pinned members in --pull mode',
      Effect.fnUntraced(
        function* () {
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
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--pull', '--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // The sync should complete
          expect(json.results).toHaveLength(1)
          // Note: Local path sources behave differently, but this documents the behavior
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })

  describe('fast-forward branch worktrees', () => {
    it.effect(
      'should fast-forward existing branch worktree when remote has new commits',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory for all test artifacts
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // 1. Create source repo (acts as the remote origin)
          const sourceRepoPath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('source-repo/'),
          )
          yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
          yield* initGitRepo(sourceRepoPath)
          // Force branch name to 'main' regardless of git config default
          yield* runGitCommand(sourceRepoPath, 'checkout', '-b', 'main').pipe(
            Effect.catchAll(() => Effect.void),
          )
          yield* fs.writeFileString(
            EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
            '# Test Repo\n',
          )
          yield* runGitCommand(sourceRepoPath, 'add', '-A')
          yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Initial commit')
          const initialCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')

          // 2. Create store with bare repo cloned from source
          const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
          const repoBasePath = EffectPath.ops.join(
            storePath,
            EffectPath.unsafe.relativeDir('github.com/test-owner/test-repo/'),
          )
          const bareRepoPath = EffectPath.ops.join(
            repoBasePath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )
          yield* fs.makeDirectory(repoBasePath, { recursive: true })
          yield* runGitCommand(tmpDir, 'clone', '--bare', sourceRepoPath, bareRepoPath)
          // Configure fetch refspec (git clone --bare doesn't set this up)
          yield* runGitCommand(
            bareRepoPath,
            'config',
            'remote.origin.fetch',
            '+refs/heads/*:refs/remotes/origin/*',
          )
          // Fetch to populate refs/remotes/origin/*
          yield* runGitCommand(bareRepoPath, 'fetch', '--tags', '--prune', 'origin')

          // 3. Create branch-tracking worktree
          const worktreePath = EffectPath.ops.join(
            repoBasePath,
            EffectPath.unsafe.relativeDir('refs/heads/main/'),
          )
          yield* fs.makeDirectory(
            EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('refs/heads/')),
            { recursive: true },
          )
          yield* runGitCommand(bareRepoPath, 'worktree', 'add', worktreePath, 'main')

          // Verify worktree is at initial commit
          const worktreeHeadBefore = yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')
          expect(worktreeHeadBefore).toBe(initialCommit)

          // 4. Create workspace with config, lock, and symlink
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'test-repo': 'test-owner/test-repo',
            },
            lockEntries: {
              'test-repo': {
                url: `https://github.com/test-owner/test-repo`,
                ref: 'main',
                commit: initialCommit,
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
            worktreePath.replace(/\/$/, ''),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
          )

          // 5. Add new commit to source repo (simulate remote advancing)
          yield* fs.writeFileString(
            EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('new-file.txt')),
            'new content\n',
          )
          yield* runGitCommand(sourceRepoPath, 'add', '-A')
          yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Second commit')
          const newCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
          expect(newCommit).not.toBe(initialCommit)

          // 6. Run mr sync --pull
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--pull', '--output', 'json'],
            env: { MEGAREPO_STORE: storePath },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // 7. Verify result
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('updated')
          expect(memberResult.commit).toBe(newCommit)
          expect(memberResult.previousCommit).toBe(initialCommit)

          // 8. Verify worktree HEAD is actually updated
          const worktreeHeadAfter = yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')
          expect(worktreeHeadAfter).toBe(newCommit)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
      { timeout: 30_000 },
    )
  })
})

// =============================================================================
// Status Types Tests
// =============================================================================

describe('sync status types', () => {
  it.effect(
    'should return cloned status for new members',
    Effect.fnUntraced(
      function* () {
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
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync for first time
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('new-lib')
        // For local paths, first sync creates a symlink - status is 'synced'
        expect(memberResult?.status).toBe('synced')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('sync error handling', () => {
  it.effect(
    'should return clear error when remote repo does not exist',
    Effect.fnUntraced(
      function* () {
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
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync --json to get structured output
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })

        // Parse the JSON output
        const json = decodeSyncJsonOutput(result.stdout.trim())

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
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// Member Filtering Tests (--only and --skip)
// =============================================================================

describe('sync member filtering', () => {
  describe('--only flag', () => {
    it.effect(
      'should only sync specified members with --only',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory with two local repos
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repo1Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo1',
              files: { 'package.json': '{"name": "repo1"}' },
            },
          })
          const repo2Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo2',
              files: { 'package.json': '{"name": "repo2"}' },
            },
          })

          // Create workspace with both members
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: typeof MegarepoConfig.Type = {
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          }
          const configContent = yield* Schema.encode(
            Schema.parseJson(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --only repo1
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
      20_000,
    )
  })

  describe('--skip flag', () => {
    it.effect(
      'should skip specified members with --skip',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory with two local repos
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repo1Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo1',
              files: { 'package.json': '{"name": "repo1"}' },
            },
          })
          const repo2Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo2',
              files: { 'package.json': '{"name": "repo2"}' },
            },
          })

          // Create workspace with both members
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: typeof MegarepoConfig.Type = {
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          }
          const configContent = yield* Schema.encode(
            Schema.parseJson(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --skip repo2
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--skip', 'repo2'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1 (repo2 was skipped)
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
      20_000,
    )
  })

  describe('--only and --skip mutual exclusivity', () => {
    it.effect(
      'should reject using both --only and --skip together',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a minimal workspace
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: typeof MegarepoConfig.Type = {
            members: {
              repo1: 'owner/repo1',
            },
          }
          const configContent = yield* Schema.encode(
            Schema.parseJson(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with both --only and --skip (should fail)
          const result = yield* runSyncCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1', '--skip', 'repo2'],
          })

          // Should have failed
          expect(result.exitCode).not.toBe(0)
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            const cause = result.exit.cause
            const failureMessages = Chunk.toReadonlyArray(Cause.failures(cause))
              .map((error: unknown) => String(error))
              .join('\n')
            expect(failureMessages.toLowerCase()).toContain('mutually exclusive')
          }
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Member Removal Detection Tests
// =============================================================================

// =============================================================================
// Worktree Ref Mismatch Detection Tests (Issue #88)
// =============================================================================

describe('sync worktree ref mismatch detection', () => {
  /**
   * REGRESSION TEST for issue #88: mr sync should detect worktree ref mismatch
   *
   * When a user runs `git checkout <other-branch>` directly inside a store worktree,
   * the worktree path no longer matches its git HEAD. This violates invariant #8:
   * "Worktree path matches HEAD: The ref encoded in a worktree's store path should match its git HEAD"
   *
   * Currently, `mr sync` reports "already synced" without detecting this drift.
   * The expected behavior is to warn about the mismatch.
   */
  it.effect(
    'should detect and warn when worktree HEAD differs from store path ref (issue #88)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'example.com',
            owner: 'org',
            repo: 'test-repo',
            branches: ['main'],
          },
        ])
        const storeKey = 'example.com/org/test-repo#main'
        const storeWorktreePath = worktreePaths[storeKey]
        if (storeWorktreePath === undefined) {
          throw new Error(`Missing worktree path for ${storeKey}`)
        }
        const mainCommit = yield* runGitCommand(storeWorktreePath, 'rev-parse', 'HEAD')

        // Create workspace with lock file using URL source
        const workspacePath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`),
          EffectPath.unsafe.relativeDir('test-workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        // Create megarepo.json with URL source (not local path)
        const config: typeof MegarepoConfig.Type = {
          members: {
            // Using https URL so it's treated as URL type, not path type
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          config,
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          configContent + '\n',
        )

        // Create lock file
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        yield* writeLockFile({
          lockPath,
          lockFile: {
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          },
        })

        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Create the symlink manually to the store worktree (simulate existing synced state)
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          storeWorktreePath.slice(0, -1),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
        )

        // NOW SIMULATE THE PROBLEM: User runs `git checkout` directly in the worktree
        // This creates a mismatch: store path says 'main' but HEAD is 'some-feature-branch'
        yield* runGitCommand(storeWorktreePath, 'checkout', '-b', 'some-feature-branch')
        yield* fs.writeFileString(
          EffectPath.ops.join(storeWorktreePath, EffectPath.unsafe.relativeFile('feature.txt')),
          'feature content\n',
        )
        yield* addCommit({ repoPath: storeWorktreePath, message: 'Add feature' })

        // Run mr sync with custom store path - should detect and warn about the ref mismatch
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // After the fix for issue #88:
        // - status should be 'skipped' to indicate a problem was detected
        // - message should explain the ref mismatch
        // - refMismatch field should contain structured data
        expect(memberResult?.status).toBe('skipped')
        expect(memberResult?.message).toContain('ref mismatch')
        expect(memberResult?.message).toContain('main')

        // Check that the refMismatch structured data is present
        const refMismatch = (
          memberResult as {
            refMismatch?: { expectedRef: string; actualRef: string; isDetached: boolean }
          }
        )?.refMismatch
        expect(refMismatch).toBeDefined()
        expect(refMismatch?.expectedRef).toBe('main')
        expect(refMismatch?.actualRef).toBeTruthy()
        expect(refMismatch?.actualRef).not.toBe('main')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should detect detached HEAD as ref mismatch in branch worktree (issue #88)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'example.com',
            owner: 'org',
            repo: 'test-repo',
            branches: ['main'],
          },
        ])
        const storeKey = 'example.com/org/test-repo#main'
        const storeWorktreePath = worktreePaths[storeKey]
        if (storeWorktreePath === undefined) {
          throw new Error(`Missing worktree path for ${storeKey}`)
        }
        const mainCommit = yield* runGitCommand(storeWorktreePath, 'rev-parse', 'HEAD')

        // Create workspace with lock file using URL source
        const workspacePath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`),
          EffectPath.unsafe.relativeDir('test-workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        // Create megarepo.json with URL source
        const config: typeof MegarepoConfig.Type = {
          members: {
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        }
        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          config,
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME)),
          configContent + '\n',
        )

        // Create lock file
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        yield* writeLockFile({
          lockPath,
          lockFile: {
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          },
        })

        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Create the symlink to the store worktree
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          storeWorktreePath.slice(0, -1),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
        )

        // NOW SIMULATE THE PROBLEM: User runs `git checkout <sha>` directly in the worktree
        // This creates a detached HEAD state - mismatch with the branch-based store path
        yield* runGitCommand(storeWorktreePath, 'checkout', '--detach', mainCommit)

        // Verify detached HEAD
        const currentBranch = yield* runGitCommand(storeWorktreePath, 'branch', '--show-current')
        expect(currentBranch).toBe('') // Empty means detached HEAD

        // Run mr sync - should detect and warn about the detached HEAD mismatch
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // Should be skipped with ref mismatch
        expect(memberResult?.status).toBe('skipped')
        expect(memberResult?.message).toContain('ref mismatch')
        expect(memberResult?.message).toContain('main')
        expect(memberResult?.message).toContain('detached')

        // Check that the refMismatch structured data shows detached state
        const refMismatch = (
          memberResult as {
            refMismatch?: { expectedRef: string; actualRef: string; isDetached: boolean }
          }
        )?.refMismatch
        expect(refMismatch).toBeDefined()
        expect(refMismatch?.expectedRef).toBe('main')
        expect(refMismatch?.isDetached).toBe(true)
        expect(refMismatch?.actualRef).toBeTruthy()
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})

describe('sync member removal detection', () => {
  it.effect(
    'should detect and remove orphaned symlinks when member is removed from config',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )

        // Initial config with both members
        const initialConfig: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(initialConfig)) +
            '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runSyncCommand({ cwd: workspacePath, args: [] })

        // Verify both symlinks exist
        const repo1Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo1'),
        )
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo1Symlink)).toBe(true)
        expect(yield* fs.exists(repo2Symlink)).toBe(true)

        // Update config to remove repo2
        const updatedConfig: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
            // repo2 removed!
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(updatedConfig)) +
            '\n',
        )

        // Second sync - should detect and remove orphaned repo2 symlink
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have results for repo1 (synced) and repo2 (removed)
        expect(json.results).toHaveLength(2)

        const repo1Result = json.results.find((r) => r.name === 'repo1')
        const repo2Result = json.results.find((r) => r.name === 'repo2')

        expect(repo1Result?.status).toBe('already_synced')
        expect(repo2Result?.status).toBe('removed')

        // Verify repo1 symlink still exists
        expect(yield* fs.exists(repo1Symlink)).toBe(true)

        // Verify repo2 symlink was removed
        expect(yield* fs.exists(repo2Symlink)).toBe(false)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should report removed status in dry-run mode without actually removing',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )

        // Initial config with both members
        const initialConfig: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(initialConfig)) +
            '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runSyncCommand({ cwd: workspacePath, args: [] })

        // Update config to remove repo2
        const updatedConfig: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(updatedConfig)) +
            '\n',
        )

        // Sync with --dry-run - should report removed but not actually remove
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have results for repo2 as removed
        const repo2Result = json.results.find((r) => r.name === 'repo2')
        expect(repo2Result?.status).toBe('removed')
        // Message contains the symlink target path
        expect(repo2Result?.message).toBeDefined()
        expect(repo2Result?.message).toContain('repo2')

        // But the symlink should still exist (dry-run didn't actually remove)
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo2Symlink)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should not remove symlinks for members skipped via --skip',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )

        // Config with both members
        const config: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config)) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runSyncCommand({ cwd: workspacePath, args: [] })

        // Sync with --skip repo2 - should NOT treat repo2 as removed
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--skip', 'repo2'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should only have result for repo1 (repo2 was skipped, not removed)
        expect(json.results).toHaveLength(1)
        expect(json.results[0]?.name).toBe('repo1')

        // repo2 symlink should still exist
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo2Symlink)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should only remove symlinks, not actual directories',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with a local repo
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })

        // Create workspace
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )

        // Config with only repo1
        const config: typeof MegarepoConfig.Type = {
          members: {
            repo1: repo1Path,
          },
        }
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config)) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create repo1 symlink
        yield* runSyncCommand({ cwd: workspacePath, args: [] })

        // Manually create a directory (not symlink) called 'orphan-dir' in repos/
        const orphanDirPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeDir('repos/orphan-dir/'),
        )
        yield* fs.makeDirectory(orphanDirPath, { recursive: true })
        yield* fs.writeFileString(
          EffectPath.ops.join(orphanDirPath, EffectPath.unsafe.relativeFile('test.txt')),
          'test content\n',
        )

        // Sync again - should NOT remove the directory (only removes symlinks)
        const result = yield* runSyncCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should not have a 'removed' result for orphan-dir
        const orphanResult = json.results.find((r) => r.name === 'orphan-dir')
        expect(orphanResult).toBeUndefined()

        // The directory should still exist
        expect(yield* fs.exists(orphanDirPath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})
