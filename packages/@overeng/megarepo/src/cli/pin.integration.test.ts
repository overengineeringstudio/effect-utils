/**
 * Pin Command Integration Tests
 *
 * Tests for the `mr config pin` command logic, including the -c flag for switching refs.
 * Pure update tests exercise helpers directly; mount-guard tests run the real CLI command.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  buildSourceStringWithRef,
  CONFIG_FILE_NAME_JSON,
  MegarepoConfig,
  parseSourceString,
  writeMegarepoConfig,
} from '../core/config.ts'
import {
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
  writeLockFile,
  LockFile,
} from '../core/lock.ts'
import { classifyRef } from '../core/ref.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { addCommit, initGitRepo, readConfig, runGitCommand } from '../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { mrCommand } from './mod.ts'

/**
 * Create a minimal test setup for pin command testing.
 */
const createMinimalTestSetup = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory structure
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
    const workspacePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('workspace/'))

    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize workspace as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: MegarepoConfig = new MegarepoConfig({
      members: {
        'test-repo': 'test-owner/test-repo',
      },
    })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
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

/** Real Git worktrees prove ownership independently of the canonical path spelling. */
const createCanonicalTestSetup = (branch: 'main' | 'team/feature') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(
      `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped())}/`,
    )
    const seed = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('seed/'))
    yield* fs.makeDirectory(seed)
    yield* initGitRepo(seed)
    yield* runGitCommand(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    const config = new MegarepoConfig({ members: { 'test-repo': 'test-owner/test-repo' } })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
    yield* fs.writeFileString(`${seed}${CONFIG_FILE_NAME_JSON}`, configContent + '\n')
    yield* addCommit({ repoPath: seed, message: 'Initialize megarepo' })
    const repo = `${tmpDir}store/github.com/test-owner/workspace`
    const bare = `${repo}/.bare`
    yield* fs.makeDirectory(repo, { recursive: true })
    yield* runGitCommand(tmpDir, 'clone', '--bare', seed, bare)
    const workspacePath = EffectPath.unsafe.absoluteDir(`${repo}/refs/heads/${branch}/`)
    if (branch === 'main') {
      yield* runGitCommand(tmpDir, '--git-dir', bare, 'worktree', 'add', workspacePath, branch)
    } else {
      yield* runGitCommand(
        tmpDir,
        '--git-dir',
        bare,
        'worktree',
        'add',
        '-b',
        branch,
        workspacePath,
        'main',
      )
    }
    const memberSeed = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('member-seed/'))
    yield* fs.makeDirectory(memberSeed)
    yield* initGitRepo(memberSeed)
    yield* runGitCommand(memberSeed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    yield* fs.writeFileString(`${memberSeed}README`, 'Test member\n')
    yield* addCommit({ repoPath: memberSeed, message: 'Initialize member' })
    const memberCommit = yield* runGitCommand(memberSeed, 'rev-parse', 'HEAD')
    const memberRepo = `${tmpDir}member-store/github.com/test-owner/test-repo`
    yield* fs.makeDirectory(memberRepo, { recursive: true })
    yield* runGitCommand(tmpDir, 'clone', '--bare', memberSeed, `${memberRepo}/.bare`)
    const memberBranchPath = EffectPath.unsafe.absoluteDir(`${memberRepo}/refs/heads/main/`)
    yield* runGitCommand(
      tmpDir,
      '--git-dir',
      `${memberRepo}/.bare`,
      'worktree',
      'add',
      memberBranchPath,
      'main',
    )
    const lockPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFile = new LockFile({
      version: 1,
      members: {
        'test-repo': createLockedMember({
          url: 'https://github.com/test-owner/test-repo',
          ref: 'main',
          commit: memberCommit,
          pinned: false,
        }),
      },
    })
    // Seed fixture state directly: shared main deliberately cannot use the writer.
    yield* fs.writeFileString(
      lockPath,
      yield* Schema.encodeEffect(Schema.fromJsonString(LockFile, { space: 2 }))(lockFile),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.MEGAREPO_STORE
        process.env.MEGAREPO_STORE = `${tmpDir}member-store`
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.MEGAREPO_STORE
          else process.env.MEGAREPO_STORE = previous
        }),
    )
    return { tmpDir, workspacePath, lockPath, memberCommit, memberBranchPath, memberRepo }
  })

const runConfigCommand = ({ cwd, args }: { cwd: AbsoluteDirPath; args: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines, getStderrLines } = yield* makeConsoleCapture
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
      '--cwd',
      cwd,
      'config',
      ...args,
    ]).pipe(Effect.provide(consoleLayer), Effect.exit)
    return {
      exit,
      stdout: (yield* getStdoutLines).join('\n'),
      stderr: (yield* getStderrLines).join('\n'),
    }
  }).pipe(Effect.scoped)

const verifyForeignMountGuard = ({
  args,
  pinned,
  mountKind,
}: {
  args: ReadonlyArray<string>
  pinned: boolean
  mountKind: 'directory' | 'file'
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { workspacePath } = yield* createMinimalTestSetup()
    const configPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
    const lockPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    yield* writeLockFile({
      lockPath,
      lockFile: new LockFile({
        version: 1,
        members: {
          'test-repo': createLockedMember({
            url: 'https://github.com/test-owner/test-repo',
            ref: 'main',
            commit: 'abc123def456789012345678901234567890abcd',
            pinned,
          }),
        },
      }),
    })

    const memberPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile('repos/test-repo'),
    )
    const sentinelPath =
      mountKind === 'directory'
        ? EffectPath.ops.join(
            EffectPath.unsafe.absoluteDir(`${memberPath}/`),
            EffectPath.unsafe.relativeFile('sentinel.bin'),
          )
        : memberPath
    const sentinel = new Uint8Array([0, 255, 34, 128, 10, 0])
    if (mountKind === 'directory') {
      yield* fs.makeDirectory(memberPath, { recursive: true })
    } else {
      const membersRoot = EffectPath.ops.parent(memberPath)
      if (membersRoot !== undefined) yield* fs.makeDirectory(membersRoot, { recursive: true })
    }
    yield* fs.writeFile(sentinelPath, sentinel)
    const configBefore = yield* fs.readFile(configPath)
    const lockBefore = yield* fs.readFile(lockPath)

    const result = yield* runConfigCommand({ cwd: workspacePath, args })
    const operation = args[0] === 'unpin' ? 'unpin' : 'pin'
    const expectedMessage = `Refusing to ${operation} member 'test-repo' at '${memberPath}': it is a foreign non-symlink mount`
    const failure = Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''

    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(`${result.stdout}\n${result.stderr}\n${failure}`).toContain(expectedMessage)
    expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
    if (mountKind === 'directory') {
      expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
    }
    expect(yield* fs.readFile(configPath)).toEqual(configBefore)
    expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe('mr config pin', () => {
  describe('canonical author workspace writes', () => {
    it.effect(
      'pins and unpins in a real slash-prefixed author workspace without switching its branch',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath, lockPath, memberCommit, memberBranchPath, memberRepo } =
            yield* createCanonicalTestSetup('team/feature')
          yield* fs.makeDirectory(`${workspacePath}repos`)
          const memberMount = `${workspacePath}repos/test-repo`
          yield* fs.symlink(memberBranchPath.replace(/\/$/, ''), memberMount)
          const configPath = EffectPath.unsafe.absoluteFile(
            `${workspacePath}${CONFIG_FILE_NAME_JSON}`,
          )
          const configBefore = yield* fs.readFile(configPath)
          const headBefore = yield* runGitCommand(workspacePath, 'rev-parse', 'HEAD')
          const result = yield* runConfigCommand({
            cwd: workspacePath,
            args: ['pin', 'test-repo', '--output', 'json'],
          })
          expect(Exit.isSuccess(result.exit)).toBe(true)
          const pinned = Option.getOrThrow(yield* readLockFile(lockPath)).members['test-repo']
          expect(pinned).toMatchObject({
            ref: 'main',
            commit: memberCommit,
            pinned: true,
          })
          expect(yield* fs.realPath(memberMount)).toBe(`${memberRepo}/refs/commits/${memberCommit}`)
          expect(yield* runGitCommand(memberBranchPath, 'symbolic-ref', 'HEAD')).toBe(
            'refs/heads/main',
          )
          expect(yield* runGitCommand(memberBranchPath, 'rev-parse', 'HEAD')).toBe(memberCommit)
          expect(yield* fs.readFile(configPath)).toEqual(configBefore)
          expect(yield* runGitCommand(workspacePath, 'symbolic-ref', 'HEAD')).toBe(
            'refs/heads/team/feature',
          )
          expect(yield* runGitCommand(workspacePath, 'rev-parse', 'HEAD')).toBe(headBefore)
          const unpin = yield* runConfigCommand({
            cwd: workspacePath,
            args: ['unpin', 'test-repo', '--output', 'json'],
          })
          expect(Exit.isSuccess(unpin.exit)).toBe(true)
          expect(
            Option.getOrThrow(yield* readLockFile(lockPath)).members['test-repo']?.pinned,
          ).toBe(false)
          expect(yield* fs.realPath(memberMount)).toBe(memberBranchPath.replace(/\/$/, ''))
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      { timeout: 60_000 },
    )

    it.effect(
      'refuses shared canonical main without changing config, lock, mounts, or Git HEAD',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath, lockPath } = yield* createCanonicalTestSetup('main')
          const configPath = EffectPath.unsafe.absoluteFile(
            `${workspacePath}${CONFIG_FILE_NAME_JSON}`,
          )
          const configBefore = yield* fs.readFile(configPath)
          const lockBefore = yield* fs.readFile(lockPath)
          const headBefore = yield* runGitCommand(workspacePath, 'rev-parse', 'HEAD')
          const configError = yield* writeMegarepoConfig({
            configPath,
            config: new MegarepoConfig({ members: {} }),
          }).pipe(Effect.flip)
          expect(configError).toMatchObject({ reason: { _tag: 'PermissionDenied' } })
          for (const args of [
            ['pin', 'test-repo', '--output', 'json'],
            ['pin', 'test-repo', '-c', 'team/other', '--output', 'json'],
            ['unpin', 'test-repo', '--output', 'json'],
          ]) {
            const result = yield* runConfigCommand({ cwd: workspacePath, args })
            expect(Exit.isFailure(result.exit)).toBe(true)
            const failure =
              Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''
            expect(`${result.stdout}\n${result.stderr}\n${failure}`).toContain('PermissionDenied')
            expect(yield* fs.readFile(configPath)).toEqual(configBefore)
            expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
            expect(yield* fs.exists(`${workspacePath}repos`)).toBe(false)
            expect(yield* runGitCommand(workspacePath, 'rev-parse', 'HEAD')).toBe(headBefore)
            expect(yield* runGitCommand(workspacePath, 'symbolic-ref', 'HEAD')).toBe(
              'refs/heads/main',
            )
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      { timeout: 15_000 },
    )

    it.effect(
      'writes author config but refuses config and mount aliases escaping that workspace',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { tmpDir, workspacePath, lockPath } =
            yield* createCanonicalTestSetup('team/feature')
          const configPath = EffectPath.unsafe.absoluteFile(
            `${workspacePath}${CONFIG_FILE_NAME_JSON}`,
          )
          const config = new MegarepoConfig({
            members: { 'test-repo': 'test-owner/test-repo#feature' },
          })
          yield* writeMegarepoConfig({ configPath, config })
          expect((yield* readConfig(workspacePath)).members['test-repo']).toBe(
            'test-owner/test-repo#feature',
          )
          const configBefore = yield* fs.readFile(configPath)
          const lockBefore = yield* fs.readFile(lockPath)
          const outside = `${tmpDir}outside`
          yield* fs.makeDirectory(outside)
          const outsideConfig = `${outside}/${CONFIG_FILE_NAME_JSON}`
          yield* fs.rename(configPath, outsideConfig)
          yield* fs.symlink(outsideConfig, configPath)
          const configError = yield* writeMegarepoConfig({ configPath, config }).pipe(Effect.flip)
          expect(configError).toMatchObject({ reason: { _tag: 'PermissionDenied' } })
          const pinAlias = yield* runConfigCommand({
            cwd: workspacePath,
            args: ['pin', 'test-repo', '--output', 'json'],
          })
          expect(Exit.isFailure(pinAlias.exit)).toBe(true)
          expect(yield* fs.readFile(outsideConfig)).toEqual(configBefore)
          expect(yield* fs.exists(`${outside}/${LOCK_FILE_NAME}`)).toBe(false)
          expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
          yield* fs.remove(configPath)
          yield* fs.rename(outsideConfig, configPath)
          yield* fs.symlink(outside, `${workspacePath}repos`)
          const mountAlias = yield* runConfigCommand({
            cwd: workspacePath,
            args: ['pin', 'test-repo', '--output', 'json'],
          })
          expect(Exit.isFailure(mountAlias.exit)).toBe(true)
          expect(yield* fs.readDirectory(outside)).toEqual([])
          expect(yield* fs.readFile(configPath)).toEqual(configBefore)
          expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      { timeout: 15_000 },
    )
  })

  describe('foreign member mount guard', () => {
    it.effect(
      'refuses pin before changing the lock or a foreign directory mount',
      () =>
        verifyForeignMountGuard({
          args: ['pin', 'test-repo', '--output', 'json'],
          pinned: false,
          mountKind: 'directory',
        }),
      { timeout: 15_000 },
    )

    it.effect(
      'refuses dry-run pin -c before changing config, lock, or a foreign file mount',
      () =>
        verifyForeignMountGuard({
          args: ['pin', 'test-repo', '-c', 'feature', '--dry-run', '--output', 'json'],
          pinned: false,
          mountKind: 'file',
        }),
      { timeout: 15_000 },
    )

    it.effect(
      'refuses unpin before changing the lock or a foreign directory mount',
      () =>
        verifyForeignMountGuard({
          args: ['unpin', 'test-repo', '--output', 'json'],
          pinned: true,
          mountKind: 'directory',
        }),
      { timeout: 15_000 },
    )
  })

  describe('config update logic', () => {
    it.effect(
      'should update megarepo.json when switching refs',
      Effect.fnUntraced(
        function* () {
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

          const updatedConfig = new MegarepoConfig({
            ...initialConfig,
            members: {
              ...initialConfig.members,
              'test-repo': newSourceString,
            },
          })

          // Write updated config
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          const newConfigContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(updatedConfig)
          yield* fs.writeFileString(configPath, newConfigContent + '\n')

          // Verify the update
          const finalConfig = yield* readConfig(workspacePath)
          expect(finalConfig.members['test-repo']).toBe('test-owner/test-repo#feature-branch')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should replace existing ref when switching',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          // First update to feature-branch
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )

          const config1: MegarepoConfig = new MegarepoConfig({
            members: {
              'test-repo': 'test-owner/test-repo#feature-branch',
            },
          })
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              config1,
            )) + '\n',
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
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('lock file update logic', () => {
    it.effect(
      'should create lock entry with pinned=true when using -c',
      Effect.fnUntraced(
        function* () {
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Simulate what pin -c does: create/update lock file
          const newRef = 'feature-branch'
          const commit = 'abc123def456789012345678901234567890abcd'

          const lockFile: LockFile = new LockFile({ version: 1, members: {} })

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
          if (Option.isSome(savedLockFile) === true) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(commit)
            expect(member?.pinned).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should update existing lock entry when switching refs',
      Effect.fnUntraced(
        function* () {
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Create initial lock file
          const initialCommit = 'abc123def456789012345678901234567890abcd'
          const initialLockFile: LockFile = new LockFile({
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://github.com/test-owner/test-repo',
                ref: 'main',
                commit: initialCommit,
                pinned: false,
              }),
            },
          })
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
          if (Option.isSome(savedLockFile) === true) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(newCommit)
            expect(member?.pinned).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
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
