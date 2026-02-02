/**
 * Status Command Integration Tests
 *
 * Tests for the status command JSON output fields:
 * - syncNeeded/syncReasons computation
 * - symlinkExists field
 * - commitDrift field
 */

import path from 'node:path'
import url from 'node:url'

import { Command, FileSystem } from '@effect/platform'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../lib/config.ts'
import { createLockedMember, type LockFile, LOCK_FILE_NAME, writeLockFile } from '../lib/lock.ts'
import {
  createRepo,
  initGitRepo,
  runGitCommand,
  getGitRev,
} from '../test-utils/setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'
import { StatusState } from './renderers/StatusOutput/schema.ts'

// Path to the CLI binary
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
 * Run the status CLI command and capture JSON output.
 */
const runStatusCommand = ({
  cwd,
  args = [],
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const command = Command.make(
      'bun',
      'run',
      CLI_PATH,
      'status',
      '--output',
      'json',
      ...args,
    ).pipe(
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

    const stdout = decodeChunks(stdoutChunks)
    const stderr = decodeChunks(stderrChunks)

    // Parse JSON output
    let status: typeof StatusState.Type | undefined
    if (stdout.trim()) {
      status = yield* Schema.decodeUnknown(Schema.parseJson(StatusState))(stdout)
    }

    return { stdout, stderr, exitCode, status }
  }).pipe(Effect.scoped)

/**
 * Create a workspace with optional lock file and symlinks.
 */
const createTestWorkspace = (args: {
  members: Record<string, string>
  lockEntries?: Record<string, { url: string; ref: string; commit: string; pinned?: boolean }>
  createSymlinks?: ReadonlyArray<{ name: string; targetPath: string }>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory for workspace
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
      const members: Record<string, ReturnType<typeof createLockedMember>> = {}

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

    // Create repos directory
    const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
    yield* fs.makeDirectory(reposDir, { recursive: true })

    // Create symlinks if specified
    if (args.createSymlinks) {
      for (const { name, targetPath } of args.createSymlinks) {
        const symlinkPath = EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile(name))
        yield* fs.symlink(targetPath, symlinkPath)
      }
    }

    // Commit config
    yield* runGitCommand(workspacePath, 'add', '-A')
    yield* runGitCommand(workspacePath, 'commit', '--no-verify', '-m', 'Initialize megarepo')

    return { workspacePath, tmpDir, reposDir }
  })

// =============================================================================
// syncNeeded and syncReasons Tests
// =============================================================================

describe('mr status --output json', () => {
  describe('syncNeeded and syncReasons', () => {
    it('should report syncNeeded=false when workspace is fully synced', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo to symlink to
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with local member (no lock needed for local members)
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'local-lib': repoPath },
            createSymlinks: [{ name: 'local-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(false)
          expect(status!.syncReasons).toEqual([])
        }),
      ))

    it('should report syncNeeded=true when symlink is missing', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with remote member but no symlink
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            lockEntries: {
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // No symlinks created - this simulates missing sync
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'effect' symlink missing")
        }),
      ))

    it('should report syncNeeded=true when lock file is missing for remote members', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with remote member but no lock file
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            // No lock entries - this simulates missing lock
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain('Lock file missing')
        }),
      ))

    it('should report syncNeeded=true when member is not in lock file', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace with one member in config but lock has different member
          const { workspacePath } = yield* createTestWorkspace({
            members: {
              effect: 'effect-ts/effect',
              'another-lib': 'owner/another-lib',
            },
            lockEntries: {
              // Only 'effect' is in lock, 'another-lib' is missing
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'another-lib' not in lock file")
        }),
      ))
  })

  // =============================================================================
  // symlinkExists Tests
  // =============================================================================

  describe('symlinkExists field', () => {
    it('should report symlinkExists=true when symlink is present', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'my-lib' },
          })

          // Create workspace with symlink
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'my-lib': repoPath },
            createSymlinks: [{ name: 'my-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'my-lib')
          expect(member).toBeDefined()
          expect(member!.symlinkExists).toBe(true)
        }),
      ))

    it('should report symlinkExists=false when symlink is missing', () =>
      withTestCtx(
        Effect.gen(function* () {
          // Create workspace without symlinks
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            lockEntries: {
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // No symlinks
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'effect')
          expect(member).toBeDefined()
          expect(member!.symlinkExists).toBe(false)
        }),
      ))
  })

  // =============================================================================
  // commitDrift Tests
  // =============================================================================

  describe('commitDrift field', () => {
    it('should report commitDrift when local commit differs from locked commit', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a repo that will have a different commit than the lock
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'drifted-lib' },
          })

          // Get the actual commit SHA
          const actualCommit = yield* getGitRev(repoPath)

          // Create workspace with lock pointing to a different (fake) commit
          const lockedCommit = 'b'.repeat(40) // Different from actual commit
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'drifted-lib': 'owner/drifted-lib' },
            lockEntries: {
              'drifted-lib': {
                url: 'https://github.com/owner/drifted-lib',
                ref: 'main',
                commit: lockedCommit,
              },
            },
            createSymlinks: [{ name: 'drifted-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'drifted-lib')
          expect(member).toBeDefined()
          expect(member!.commitDrift).toBeDefined()
          expect(member!.commitDrift!.localCommit).toBe(actualCommit)
          expect(member!.commitDrift!.lockedCommit).toBe(lockedCommit)
        }),
      ))

    it('should not report commitDrift when commits match', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'synced-lib' },
          })

          // Get the actual commit SHA
          const actualCommit = yield* getGitRev(repoPath)

          // Create workspace with lock pointing to the same commit
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'synced-lib': 'owner/synced-lib' },
            lockEntries: {
              'synced-lib': {
                url: 'https://github.com/owner/synced-lib',
                ref: 'main',
                commit: actualCommit, // Same as actual
              },
            },
            createSymlinks: [{ name: 'synced-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'synced-lib')
          expect(member).toBeDefined()
          expect(member!.commitDrift).toBeUndefined()
        }),
      ))

    it('should not report commitDrift for local path members', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with local path member (uses path, not github shorthand)
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'local-lib': repoPath }, // Path source = local
            // No lock entries for local members
            createSymlinks: [{ name: 'local-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'local-lib')
          expect(member).toBeDefined()
          expect(member!.isLocal).toBe(true)
          expect(member!.commitDrift).toBeUndefined()
        }),
      ))
  })

  // =============================================================================
  // Combined scenarios
  // =============================================================================

  describe('combined scenarios', () => {
    it('should correctly report status for mixed local and remote members', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with both local and remote members
          const { workspacePath } = yield* createTestWorkspace({
            members: {
              'local-lib': localRepoPath,
              'remote-lib': 'owner/remote-lib',
            },
            lockEntries: {
              'remote-lib': {
                url: 'https://github.com/owner/remote-lib',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // Only local member has symlink - remote is missing
            createSymlinks: [{ name: 'local-lib', targetPath: localRepoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()

          // Local member should be fully synced
          const localMember = status!.members.find((m) => m.name === 'local-lib')
          expect(localMember).toBeDefined()
          expect(localMember!.isLocal).toBe(true)
          expect(localMember!.symlinkExists).toBe(true)
          expect(localMember!.exists).toBe(true)

          // Remote member should be missing symlink
          const remoteMember = status!.members.find((m) => m.name === 'remote-lib')
          expect(remoteMember).toBeDefined()
          expect(remoteMember!.isLocal).toBe(false)
          expect(remoteMember!.symlinkExists).toBe(false)
          expect(remoteMember!.exists).toBe(false)

          // Overall sync needed due to missing remote member
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'remote-lib' symlink missing")
        }),
      ))
  })
})
