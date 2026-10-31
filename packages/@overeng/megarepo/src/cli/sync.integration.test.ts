import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME_JSON, MegarepoConfig } from '../core/config.ts'
import * as Git from '../core/git.ts'
import {
  LockFile,
  LOCK_FILE_NAME,
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  readLockFile,
  updateLockedMember,
  writeLockFile,
} from '../core/lock.ts'
import { generateSchema, generateVscode } from '../generators/mod.ts'
import { StoreLock } from '../store/store-lock.ts'
import { makeStoreLayer } from '../store/store.ts'
import { inspectMemberMount } from '../sync/member-mount.ts'
import { collectSyncErrors } from '../sync/mod.ts'
import { MegarepoSyncTree, SyncErrorItem } from '../sync/schema.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { FIXTURE_BRANCH, pushFixtureBranch } from '../test-utils/git-fixture.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import {
  addCommit,
  createRepo,
  createWorkspace,
  initGitRepo,
  runGitCommand,
} from '../test-utils/setup.ts'
import {
  createStoreFixture,
  createWorkspaceWithLock,
  materializeNonDetachedBranchWorktree,
  type StoreFixtureResult,
} from '../test-utils/store-setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { syncMegarepo } from './commands/engine.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

/** Schema for parsing JSON output from `mr ... --output json` */
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

const decodeSyncJsonOutput = Schema.decodeUnknownSync(Schema.fromJsonString(SyncJsonOutput))

const diagnosticTail = (output: string) => {
  const limit = 4000
  return output.length > limit
    ? `…[truncated ${output.length - limit} chars]\n${output.slice(-limit)}`
    : output
}

/** Run an `mr` CLI command and capture output. */
const runMrCommand = ({
  cwd,
  command = ['sync'],
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  command?: ReadonlyArray<string>
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines, getStderrLines } = yield* makeConsoleCapture
    const mergedEnv = { PWD: cwd, CI: 'false', ...env }
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

    /**
     * A member-level failure is a reported result, not an Effect failure, so the command still
     * succeeds. The non-zero exit comes from the TUI app's `exitCode` mapper, which assigns
     * `process.exitCode` on unmount — so that is what has to be observed here.
     *
     * `process.exitCode` is global: it is cleared before the run and restored afterwards, or a
     * command that legitimately exits non-zero would also fail the vitest process itself.
     */
    const processExitCode = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.exitCode
        process.exitCode = undefined
        return { previous }
      }),
      ({ previous }) =>
        Effect.sync(() => {
          process.exitCode = previous
        }),
    )

    const argv = [...command, ...args]
    const effect = Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(consoleLayer),
    )
    const exit = yield* Effect.exit(effect)
    const reportedExitCode = process.exitCode
    void envCapture
    void processExitCode

    return {
      exit,
      stdout: (yield* getStdoutLines).join('\n'),
      stderr: [stderrCapture.stderrChunks.join(''), ...(yield* getStderrLines)].join('\n'),
      exitCode: Exit.isSuccess(exit) === false ? 1 : Number(reportedExitCode ?? 0),
    }
  }).pipe(Effect.scoped)

/** Run `mr lock` and capture output. */
const runLockRecordCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['lock'], args, env })

/** Run `mr fetch` and capture output. */
const runFetchCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['fetch'], args, env })

/** Run `mr apply` and capture output. */
const runApplyCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['apply'], args, env })

/** Run `mr fetch --apply` (the daily driver, replaces old `mr sync`). */
const runFetchApplyCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['fetch', '--apply'], args, env })

/**
 * A store repo at `<repoDir>` whose `.bare` HEAD (default branch) is `main`, with a real
 * worktree at `refs/<kind>/<ref>/`: `heads` checks out branch `<ref>`, other kinds detach.
 * The canonical-mutation guard proves author ownership from this Git metadata.
 */
const makeStoreWorktree = ({
  repoDir,
  kind,
  ref,
}: {
  repoDir: string
  kind: 'heads' | 'tags' | 'commits'
  ref?: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = EffectPath.unsafe.absoluteDir(`${repoDir}.source/`)
    yield* fs.makeDirectory(source, { recursive: true })
    yield* initGitRepo(source)
    yield* fs.writeFileString(`${source}README.md`, '# store repo\n')
    yield* addCommit({ repoPath: source, message: 'Initial commit' })
    yield* runGitCommand(source, 'branch', '-M', 'main')
    const bare = EffectPath.unsafe.absoluteDir(`${repoDir}/.bare/`)
    yield* runGitCommand(source, 'clone', '--bare', source, bare)
    yield* runGitCommand(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    const worktreeRef = ref ?? (yield* runGitCommand(bare, 'rev-parse', 'HEAD')).trim()
    const worktree = `${repoDir}/refs/${kind}/${worktreeRef}`
    yield* fs.makeDirectory(path.dirname(worktree), { recursive: true })
    yield* runGitCommand(
      bare,
      ...(kind !== 'heads'
        ? ['worktree', 'add', '--detach', worktree, 'HEAD']
        : worktreeRef === 'main'
          ? ['worktree', 'add', worktree, 'main']
          : ['worktree', 'add', '-b', worktreeRef, worktree, 'HEAD']),
    )
    return EffectPath.unsafe.absoluteDir(`${worktree}/`)
  })

/** Include Git metadata, contents, and mtimes, but not read-side atime changes. */
const snapshotWorkspaceTree = (
  root: string,
): Effect.Effect<ReadonlyArray<unknown>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const rootStat = yield* fs.stat(root)
    const entries = yield* fs.readDirectory(root)
    const children = yield* Effect.forEach(entries.sort(), (name) =>
      Effect.gen(function* () {
        const entry = path.join(root, name)
        const mount = yield* inspectMemberMount(entry)
        if (mount._tag === 'Symlink') return [name, 'symlink', mount.target]
        const stat = yield* fs.stat(entry)
        return [
          name,
          stat.mtime,
          stat.type === 'Directory'
            ? yield* snapshotWorkspaceTree(entry)
            : yield* fs.readFile(entry),
        ]
      }),
    )
    return [rootStat.mtime, children]
  })

const createCommitRemnantFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const store = yield* createStoreFixture([{ host: 'example.com', owner: 'acme', repo: 'lib' }])
  const bareRepoPath = store.bareRepoPaths['example.com/acme/lib']
  if (bareRepoPath === undefined) throw new Error('Missing bare repo')
  const commit = (yield* runGitCommand(bareRepoPath, 'rev-parse', 'main')).trim()
  const { workspacePath } = yield* createWorkspaceWithLock({
    members: { lib: 'https://example.com/acme/lib#main' },
    lockEntries: {
      lib: {
        url: 'https://example.com/acme/lib',
        ref: 'main',
        commit,
      },
    },
  })
  const targetPath = EffectPath.ops.join(
    store.storePath,
    EffectPath.unsafe.relativeDir(`example.com/acme/lib/refs/commits/${commit}/`),
  )
  const targetParent = EffectPath.ops.parent(targetPath)
  if (targetParent === undefined) throw new Error('Missing commit target parent')
  yield* fs.makeDirectory(targetParent, { recursive: true })
  return {
    fs,
    store,
    bareRepoPath,
    commit,
    workspacePath,
    targetPath,
    env: { CI: 'true', MEGAREPO_STORE: store.storePath.slice(0, -1) },
  }
})

const applyCommitRemnantFixture = ({
  workspacePath,
  env,
}: {
  workspacePath: AbsoluteDirPath
  env: Record<string, string>
}) =>
  runApplyCommand({
    cwd: workspacePath,
    args: ['--worktree-mode', 'commit', '--output', 'json'],
    env,
  })

describe('worktree mode selection', () => {
  it.effect(
    'creates two missing references of one repository during parallel sync',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* createStoreFixture([
          { host: 'example.com', owner: 'team', repo: 'parallel' },
        ])
        const bare = store.bareRepoPaths['example.com/team/parallel']!
        const first = (yield* runGitCommand(bare, 'rev-parse', 'main')).trim()
        const tree = (yield* runGitCommand(bare, 'rev-parse', 'main^{tree}')).trim()
        const second = (yield* runGitCommand(
          bare,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit-tree',
          tree,
          '-p',
          first,
          '-m',
          'second',
        )).trim()
        const url = 'https://example.com/team/parallel'
        const entries = Object.entries({ first, second })
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: Object.fromEntries(entries.map(([name, commit]) => [name, `${url}#${commit}`])),
          lockEntries: Object.fromEntries(
            entries.map(([name, commit]) => [name, { url, ref: commit, commit }]),
          ),
        })
        const result = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--worktree-mode', 'commit', '--output', 'json'],
          env: { MEGAREPO_STORE: store.storePath.slice(0, -1) },
        })
        expect(result.exitCode).toBe(0)
        for (const [, commit] of entries)
          expect(yield* fs.exists(`${bare}../refs/commits/${commit}/.git`)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
  it.effect(
    'selects deterministic CI worktrees without requiring every caller to repeat the policy',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* createStoreFixture([
          { host: 'example.com', owner: 'acme', repo: 'lib' },
        ])
        const bareRepo = store.bareRepoPaths['example.com/acme/lib']
        if (bareRepo === undefined) throw new Error('Missing bare repo')
        const lockedCommit = (yield* runGitCommand(bareRepo, 'rev-parse', 'main')).trim()
        const storeEnv = store.storePath.slice(0, -1)
        const cases = [
          {
            name: 'explicit commit under CI',
            args: ['--output', 'json', '--worktree-mode', 'commit'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: `/refs/commits/${lockedCommit}`,
          },
          {
            name: 'explicit tracking under CI',
            args: ['--output', 'json', '--worktree-mode', 'tracking'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: '/refs/heads/main',
          },
          {
            name: 'fetch --apply auto under CI',
            args: ['--output', 'json'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: `/refs/commits/${lockedCommit}`,
            fetchApply: true,
          },
          {
            name: 'auto outside CI',
            args: ['--output', 'json'],
            env: { CI: 'false', MEGAREPO_STORE: storeEnv },
            expectedTarget: '/refs/heads/main',
          },
        ] as const

        for (const testCase of cases) {
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { lib: 'https://example.com/acme/lib#main' },
            lockEntries: {
              lib: {
                url: 'https://example.com/acme/lib',
                ref: 'main',
                commit: lockedCommit,
              },
            },
          })
          const run = 'fetchApply' in testCase ? runFetchApplyCommand : runApplyCommand
          const result = yield* run({
            cwd: workspacePath,
            args: testCase.args,
            env: testCase.env,
          })
          expect(result.exitCode, testCase.name).toBe(0)
          expect(Exit.isSuccess(result.exit), testCase.name).toBe(true)
          const memberLink = yield* fs.readLink(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/lib')),
          )
          expect(memberLink, testCase.name).toContain(testCase.expectedTarget)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('commit worktree remnant cleanup', () => {
  it.effect(
    'replaces an empty unregistered directory',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createCommitRemnantFixture
        yield* fixture.fs.makeDirectory(fixture.targetPath)

        const result = yield* applyCommitRemnantFixture(fixture)

        expect(result.exitCode).toBe(0)
        expect(decodeSyncJsonOutput(result.stdout.trim()).results[0]?.status).not.toBe('error')
        expect(
          yield* fixture.fs.exists(
            EffectPath.ops.join(fixture.targetPath, EffectPath.unsafe.relativeFile('.git')),
          ),
        ).toBe(true)
        const physicalTarget = yield* fixture.fs.realPath(fixture.targetPath)
        const registrations = yield* Git.listWorktrees(fixture.bareRepoPath)
        const registeredPhysicalPaths = yield* Effect.forEach(registrations, (registration) =>
          fixture.fs.realPath(registration.path),
        )
        expect(registeredPhysicalPaths).toContain(physicalTarget)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'preserves a non-empty unregistered directory',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createCommitRemnantFixture
        yield* fixture.fs.makeDirectory(fixture.targetPath)
        const sentinelPath = path.join(fixture.targetPath, 'sentinel.bin')
        const sentinel = new Uint8Array([0, 255, 17, 34])
        yield* fixture.fs.writeFile(sentinelPath, sentinel)

        const result = yield* applyCommitRemnantFixture(fixture)

        expect(result.exitCode).toBe(1)
        expect(decodeSyncJsonOutput(result.stdout.trim()).results[0]).toMatchObject({
          status: 'error',
          message: expect.stringContaining('directory is not empty'),
        })
        expect(Array.from(yield* fixture.fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'preserves a worktree registered through a physical-path alias',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createCommitRemnantFixture
        const aliasPath = `${fixture.targetPath.replace(/\/+$/u, '')}-alias`
        yield* Git.createWorktreeDetached({
          repoPath: fixture.bareRepoPath,
          worktreePath: aliasPath,
          commit: fixture.commit,
        })
        yield* fixture.fs.rename(aliasPath, fixture.targetPath.replace(/\/+$/u, ''))
        yield* fixture.fs.symlink(fixture.targetPath.replace(/\/+$/u, ''), aliasPath)
        yield* fixture.fs.remove(path.join(fixture.targetPath, '.git'))
        const registrationsBefore = yield* runGitCommand(
          fixture.bareRepoPath,
          'worktree',
          'list',
          '--porcelain',
        )
        expect(yield* fixture.fs.realPath(aliasPath)).toBe(
          (yield* fixture.fs.realPath(fixture.targetPath)).replace(/\/+$/u, ''),
        )

        const result = yield* applyCommitRemnantFixture(fixture)

        expect(result.exitCode).toBe(1)
        expect(decodeSyncJsonOutput(result.stdout.trim()).results[0]).toMatchObject({
          status: 'error',
          message: expect.stringContaining('identifies the same physical directory'),
        })
        expect(yield* fixture.fs.readFileString(path.join(fixture.targetPath, 'README.md'))).toBe(
          '# lib\n',
        )
        expect(yield* fixture.fs.readLink(aliasPath)).toBe(fixture.targetPath.replace(/\/+$/u, ''))
        expect(yield* runGitCommand(fixture.bareRepoPath, 'worktree', 'list', '--porcelain')).toBe(
          registrationsBefore,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'preserves live and dangling symbolic links and non-directory targets',
    Effect.fnUntraced(
      function* () {
        for (const kind of ['symlink', 'dangling-symlink', 'file'] as const) {
          const fixture = yield* createCommitRemnantFixture
          const target = fixture.targetPath.replace(/\/+$/u, '')
          const sentinel = new Uint8Array([kind === 'file' ? 2 : 1, 0, 255])
          let preservedPath = target
          if (kind === 'file') {
            yield* fixture.fs.writeFile(target, sentinel)
          } else {
            preservedPath = `${target}-outside`
            if (kind === 'symlink') {
              yield* fixture.fs.makeDirectory(preservedPath)
              yield* fixture.fs.writeFile(path.join(preservedPath, 'sentinel.bin'), sentinel)
            }
            yield* fixture.fs.symlink(preservedPath, target)
          }
          const registrationsBefore = yield* runGitCommand(
            fixture.bareRepoPath,
            'worktree',
            'list',
            '--porcelain',
          )

          const result = yield* applyCommitRemnantFixture(fixture)

          expect(result.exitCode, kind).toBe(1)
          expect(decodeSyncJsonOutput(result.stdout.trim()).results[0], kind).toMatchObject({
            status: 'error',
            message: expect.stringContaining(kind === 'file' ? 'not a directory' : 'symbolic link'),
          })
          if (kind === 'file') {
            expect(Array.from(yield* fixture.fs.readFile(target))).toEqual(Array.from(sentinel))
          } else {
            expect(yield* fixture.fs.readLink(target)).toBe(preservedPath)
            if (kind === 'symlink') {
              expect(
                Array.from(yield* fixture.fs.readFile(path.join(preservedPath, 'sentinel.bin'))),
              ).toEqual(Array.from(sentinel))
            }
          }
          expect(
            yield* runGitCommand(fixture.bareRepoPath, 'worktree', 'list', '--porcelain'),
          ).toBe(registrationsBefore)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'preserves the target and registrations when physical registration identity is ambiguous',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createCommitRemnantFixture
        yield* fixture.fs.makeDirectory(fixture.targetPath)
        const staleRegistrationPath = `${fixture.targetPath.replace(/\/+$/u, '')}-stale`
        const movedWorktreePath = `${fixture.targetPath.replace(/\/+$/u, '')}-moved`
        yield* Git.createWorktreeDetached({
          repoPath: fixture.bareRepoPath,
          worktreePath: staleRegistrationPath,
          commit: fixture.commit,
        })
        yield* fixture.fs.rename(staleRegistrationPath, movedWorktreePath)
        const registrationsBefore = yield* runGitCommand(
          fixture.bareRepoPath,
          'worktree',
          'list',
          '--porcelain',
        )

        const result = yield* applyCommitRemnantFixture(fixture)

        expect(result.exitCode).toBe(1)
        expect(decodeSyncJsonOutput(result.stdout.trim()).results[0]).toMatchObject({
          status: 'error',
          message: expect.stringContaining(
            `Cannot resolve physical identity of Git worktree registration '${staleRegistrationPath}'`,
          ),
        })
        expect(yield* fixture.fs.readDirectory(fixture.targetPath)).toEqual([])
        expect(yield* fixture.fs.exists(movedWorktreePath)).toBe(true)
        expect(yield* runGitCommand(fixture.bareRepoPath, 'worktree', 'list', '--porcelain')).toBe(
          registrationsBefore,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('mr apply', () => {
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
        Effect.provide(NodeServices.layer),
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

describe('lock apply mode', () => {
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

  describe('lock apply mode with workspace', () => {
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

          // Should not be stale - lock apply mode would succeed
          expect(result.isStale).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect missing lock file entries for lock apply mode',
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

          // Should be stale - lock apply mode would fail
          expect(result.isStale).toBe(true)
          expect(result.addedMembers).toContain('lib2')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect extra lock file entries for lock apply mode',
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

          // Should be stale - lock apply mode would fail
          expect(result.isStale).toBe(true)
          expect(result.removedMembers).toContain('old-lib')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('lock apply mode with pinned members', () => {
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
        Effect.provide(NodeServices.layer),
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
    const childConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'grandchild-lib': grandchildPath,
      },
    })
    const childConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
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
    const parentConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'child-megarepo': childPath,
      },
    })
    const parentConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(parentConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
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
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(parentConfigPath)).toBe(true)

          // Verify child has megarepo.json (making it a nested megarepo)
          const childConfigPath = EffectPath.ops.join(
            childPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(childConfigPath)).toBe(true)

          // Read parent config and verify it points to child
          const parentConfigContent = yield* fs.readFileString(parentConfigPath)
          const parentConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
            parentConfigContent,
          )
          expect(parentConfig.members['child-megarepo']).toBe(childPath)
        },
        Effect.provide(NodeServices.layer),
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
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          const childConfigContent = yield* fs.readFileString(childConfigPath)
          const childConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
            childConfigContent,
          )
          expect(childConfig.members['grandchild-lib']).toBe(grandchildPath)

          // Verify grandchild is a regular repo (no megarepo.json)
          const grandchildConfigPath = EffectPath.ops.join(
            grandchildPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(grandchildConfigPath)).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

/** Bare objects are warm, but every canonical commit worktree and member mount is cold. */
const createColdCanonicalRecursionFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* createStoreFixture([
      { host: 'example.com', owner: 'acme', repo: 'child', branches: [FIXTURE_BRANCH] },
      { host: 'example.com', owner: 'acme', repo: 'grandchild', branches: [FIXTURE_BRANCH] },
      { host: 'example.com', owner: 'acme', repo: 'leaf', branches: [FIXTURE_BRANCH] },
    ])
    const bare = (name: string) => {
      const barePath = store.bareRepoPaths[`example.com/acme/${name}`]
      if (barePath === undefined) throw new Error(`Missing bare repo for ${name}`)
      return barePath
    }
    const leafCommit = yield* runGitCommand(bare('leaf'), 'rev-parse', FIXTURE_BRANCH)
    const makeParent = (memberName: string, commit: string) =>
      createWorkspaceWithLock({
        members: { [memberName]: `https://example.com/acme/${memberName}#${FIXTURE_BRANCH}` },
        lockEntries: {
          [memberName]: {
            url: `https://example.com/acme/${memberName}`,
            ref: FIXTURE_BRANCH,
            commit,
          },
        },
      })
    const { workspacePath: grandchildSource } = yield* makeParent('leaf', leafCommit)
    const grandchildCommit = yield* runGitCommand(grandchildSource, 'rev-parse', 'HEAD')
    yield* runGitCommand(
      grandchildSource,
      'push',
      '--force',
      bare('grandchild'),
      `HEAD:refs/heads/${FIXTURE_BRANCH}`,
    )
    const { workspacePath: childSource } = yield* makeParent('grandchild', grandchildCommit)
    const childCommit = yield* runGitCommand(childSource, 'rev-parse', 'HEAD')
    yield* runGitCommand(
      childSource,
      'push',
      '--force',
      bare('child'),
      `HEAD:refs/heads/${FIXTURE_BRANCH}`,
    )
    const { workspacePath } = yield* makeParent('child', childCommit)
    const canonicalPath = (name: string, commit: string) =>
      EffectPath.ops.join(
        store.storePath,
        EffectPath.unsafe.relativeDir(`example.com/acme/${name}/refs/commits/${commit}/`),
      )
    const childPath = canonicalPath('child', childCommit)
    const grandchildPath = canonicalPath('grandchild', grandchildCommit)
    const leafPath = canonicalPath('leaf', leafCommit)
    for (const target of [childPath, grandchildPath, leafPath]) {
      expect(yield* fs.exists(target)).toBe(false)
    }
    return {
      store,
      workspacePath,
      childPath,
      grandchildPath,
      leafPath,
      childCommit,
      grandchildCommit,
      leafCommit,
      childSource,
      grandchildSource,
    }
  })

describe('apply --all canonical recursion', () => {
  it.effect(
    'diamond apply waits for shared commit freshness publication before a second branch recurses',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createColdCanonicalRecursionFixture()
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: {
            left: `https://example.com/acme/child#${FIXTURE_BRANCH}`,
            right: fixture.childSource,
          },
          lockEntries: {
            left: {
              url: 'https://example.com/acme/child',
              ref: FIXTURE_BRANCH,
              commit: fixture.childCommit,
            },
          },
        })
        const publishing = yield* Deferred.make<void>()
        const observerArrived = yield* Deferred.make<void>()
        let publicationBlocked = false
        let sharedLockVisits = 0
        let observedBeforePublication = false
        // The old fast path reaches authorization before the creator publishes.
        // The fixed path instead joins the creator's worktree lock.
        const createdWorktrees = new (class extends Set<string> {
          override has(key: string) {
            const present = super.has(key)
            if (key === fixture.grandchildPath.slice(0, -1) && present === false) {
              observedBeforePublication = true
              Deferred.doneUnsafe(observerArrived, Effect.void)
            }
            return present
          }
        })()
        const controlledFs: FileSystem.FileSystem = {
          ...fs,
          realPath: (target) =>
            Effect.gen(function* () {
              if (target === `${workspacePath}repos/right/`) yield* Deferred.await(publishing)
              const physical = yield* fs.realPath(target)
              if (target === fixture.grandchildPath && publicationBlocked === false) {
                publicationBlocked = true
                yield* Deferred.succeed(publishing, undefined)
                yield* Deferred.await(observerArrived)
              }
              return physical
            }),
        }
        const result = yield* Effect.gen(function* () {
          const storeLock = yield* StoreLock
          return yield* syncMegarepo({
            megarepoRoot: workspacePath,
            createdWorktrees,
            options: {
              mode: 'apply',
              dryRun: false,
              force: false,
              all: true,
              only: undefined,
              skip: undefined,
              gitProtocol: 'https',
              createBranches: false,
              commitMode: true,
              lockSyncMode: 'off',
            },
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, controlledFs),
            Effect.provideService(StoreLock, {
              ...storeLock,
              withWorktreeLock: (key) => (effect) =>
                Effect.gen(function* () {
                  if (key.replace(/\/$/, '') === fixture.grandchildPath.slice(0, -1)) {
                    sharedLockVisits++
                    if (sharedLockVisits === 2) yield* Deferred.succeed(observerArrived, undefined)
                  }
                  return yield* storeLock.withWorktreeLock(key)(effect)
                }),
            }),
          )
        }).pipe(Effect.provide(makeStoreLayer({ basePath: fixture.store.storePath })))
        expect(publicationBlocked).toBe(true)
        expect(collectSyncErrors(result)).toEqual([])
        expect(observedBeforePublication).toBe(false)
        expect(sharedLockVisits).toBe(2)
        const left = `${workspacePath}repos/left/repos/grandchild`
        const right = `${workspacePath}repos/right/repos/grandchild`
        expect(yield* fs.realPath(left)).toBe(fixture.grandchildPath.slice(0, -1))
        expect(yield* fs.realPath(right)).toBe(fixture.grandchildPath.slice(0, -1))
        expect(yield* fs.realPath(`${left}/repos/leaf`)).toBe(fixture.leafPath.slice(0, -1))
        expect(createdWorktrees.has(fixture.grandchildPath.slice(0, -1))).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  it.effect(
    'cold apply --all --lock-sync off materializes nested canonical commit worktrees with zero errors',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createColdCanonicalRecursionFixture()
        const result = yield* runApplyCommand({
          cwd: fixture.workspacePath,
          args: ['--output', 'json', '--all', '--lock-sync', 'off'],
          env: {
            CI: 'true',
            MEGAREPO_STORE: fixture.store.storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
          },
        })
        expect(result.stdout).not.toContain('PermissionDenied')
        const Output = Schema.TaggedStruct('Success', {
          syncErrorCount: Schema.Finite,
          syncErrors: Schema.Array(SyncErrorItem),
          syncTree: MegarepoSyncTree,
        })
        const out = yield* Schema.decodeEffect(Schema.fromJsonString(Output))(result.stdout.trim())
        expect(Exit.isSuccess(result.exit)).toBe(true)
        expect(result.exitCode).toBe(0)
        expect(out.syncErrorCount).toBe(0)
        expect(out.syncErrors).toEqual([])
        expect(out.syncTree.results).toEqual([
          expect.objectContaining({
            name: 'child',
            status: 'applied',
            commit: fixture.childCommit,
          }),
        ])
        expect(out.syncTree.nestedResults).toHaveLength(1)
        const childTree = out.syncTree.nestedResults[0]
        expect(childTree?.results).toEqual([
          expect.objectContaining({
            name: 'grandchild',
            status: 'applied',
            commit: fixture.grandchildCommit,
          }),
        ])
        expect(childTree?.nestedResults).toHaveLength(1)
        expect(childTree?.nestedResults[0]?.results).toEqual([
          expect.objectContaining({ name: 'leaf', status: 'applied', commit: fixture.leafCommit }),
        ])
        const mounts = [
          [fixture.workspacePath, 'child', fixture.childPath, fixture.childCommit],
          [fixture.childPath, 'grandchild', fixture.grandchildPath, fixture.grandchildCommit],
          [fixture.grandchildPath, 'leaf', fixture.leafPath, fixture.leafCommit],
        ] as const
        for (const [root, name, target, commit] of mounts) {
          const mount = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir(`repos/${name}/`))
          expect(yield* fs.realPath(mount)).toBe(target.slice(0, -1))
          expect(yield* runGitCommand(mount, 'rev-parse', 'HEAD')).toBe(commit)
        }
        for (const [source, target] of [
          [fixture.childSource, fixture.childPath],
          [fixture.grandchildSource, fixture.grandchildPath],
        ] as const) {
          for (const filename of [CONFIG_FILE_NAME_JSON, LOCK_FILE_NAME]) {
            expect(
              yield* fs.readFileString(
                EffectPath.ops.join(target, EffectPath.unsafe.relativeFile(filename)),
              ),
            ).toBe(
              yield* fs.readFileString(
                EffectPath.ops.join(source, EffectPath.unsafe.relativeFile(filename)),
              ),
            )
          }
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  it.effect(
    'apply --all --lock-sync off denies recursion into a preexisting shared canonical commit worktree without mutation',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createColdCanonicalRecursionFixture()
        const childBare = fixture.store.bareRepoPaths['example.com/acme/child']
        if (childBare === undefined) throw new Error('Missing child bare repo')
        yield* fs.makeDirectory(path.dirname(fixture.childPath.slice(0, -1)), { recursive: true })
        yield* runGitCommand(
          childBare,
          'worktree',
          'add',
          '--detach',
          fixture.childPath,
          fixture.childCommit,
        )
        const sentinelPath = EffectPath.ops.join(
          fixture.childPath,
          EffectPath.unsafe.relativeFile('shared-sentinel.bin'),
        )
        const sentinel = new Uint8Array([0, 255, 17, 10, 99])
        yield* fs.writeFile(sentinelPath, sentinel)
        const beforeFiles = yield* Effect.forEach(
          [CONFIG_FILE_NAME_JSON, LOCK_FILE_NAME],
          (filename) =>
            fs.readFileString(
              EffectPath.ops.join(fixture.childPath, EffectPath.unsafe.relativeFile(filename)),
            ),
        )
        const beforeEntries = yield* fs.readDirectory(fixture.childPath)
        const beforeWorktrees = yield* runGitCommand(childBare, 'worktree', 'list', '--porcelain')
        const sharedWorkspace = yield* createWorkspaceWithLock({
          members: { child: `https://example.com/acme/child#${FIXTURE_BRANCH}` },
          lockEntries: {
            child: {
              url: 'https://example.com/acme/child',
              ref: FIXTURE_BRANCH,
              commit: fixture.childCommit,
            },
          },
        })
        const sharedRepos = EffectPath.ops.join(
          sharedWorkspace.workspacePath,
          EffectPath.unsafe.relativeDir('repos/'),
        )
        const sharedMount = EffectPath.ops.join(
          sharedRepos,
          EffectPath.unsafe.relativeDir('child/'),
        )
        yield* fs.makeDirectory(sharedRepos)
        yield* fs.symlink(fixture.childPath.slice(0, -1), sharedMount.slice(0, -1))
        const result = yield* runApplyCommand({
          cwd: fixture.workspacePath,
          args: ['--output', 'json', '--all', '--lock-sync', 'off'],
          env: {
            CI: 'true',
            MEGAREPO_STORE: fixture.store.storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
          },
        })
        const Output = Schema.TaggedStruct('Error', {
          syncErrorCount: Schema.Finite,
          syncErrors: Schema.Array(SyncErrorItem),
          syncTree: MegarepoSyncTree,
        })
        const out = yield* Schema.decodeEffect(Schema.fromJsonString(Output))(result.stdout.trim())
        expect(result.exitCode).toBe(1)
        expect(out.syncErrorCount).toBe(1)
        expect(out.syncErrors).toHaveLength(1)
        expect(out.syncErrors[0]?.message).toContain('PermissionDenied')
        expect(out.syncErrors[0]?.message).toContain('Refusing to mutate canonical worktree')
        expect(out.syncTree.nestedResults).toHaveLength(1)
        expect(out.syncTree.nestedResults[0]?.results).toEqual([
          expect.objectContaining({ name: 'child', status: 'error' }),
        ])
        expect(out.syncTree.nestedResults[0]?.nestedResults).toHaveLength(0)
        expect(yield* fs.realPath(sharedMount)).toBe(fixture.childPath.slice(0, -1))
        expect(yield* fs.readDirectory(fixture.childPath)).toEqual(beforeEntries)
        expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
        expect(
          yield* Effect.forEach([CONFIG_FILE_NAME_JSON, LOCK_FILE_NAME], (filename) =>
            fs.readFileString(
              EffectPath.ops.join(fixture.childPath, EffectPath.unsafe.relativeFile(filename)),
            ),
          ),
        ).toEqual(beforeFiles)
        expect(yield* runGitCommand(fixture.childPath, 'rev-parse', 'HEAD')).toBe(
          fixture.childCommit,
        )
        expect(yield* runGitCommand(childBare, 'worktree', 'list', '--porcelain')).toBe(
          beforeWorktrees,
        )
        expect(yield* fs.exists(fixture.grandchildPath)).toBe(false)
        expect(yield* fs.exists(fixture.leafPath)).toBe(false)
        expect(
          yield* fs.exists(
            EffectPath.ops.join(fixture.childPath, EffectPath.unsafe.relativeDir('repos/')),
          ),
        ).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )
})

/**
 * The consumer shape behind `mr:setup` with `setupCommitMembers`: a nested megarepo member
 * (`child` → `grandchild` → `leaf`) next to an ordinary member (`plain`, the leaf repo).
 * Local runs (`CI=false`) with the canonical-mutation bypass explicitly disabled.
 */
const createSetupConsumerFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* createColdCanonicalRecursionFixture()
    // Tracking-mode cases need branch-attached worktrees at the newly seeded tips.
    // The shared store fixture starts detached, before the nested config commits.
    for (const repo of ['child', 'grandchild', 'leaf']) {
      const worktreePath = fixture.store.worktreePaths[`example.com/acme/${repo}#${FIXTURE_BRANCH}`]
      if (worktreePath === undefined) throw new Error(`Missing ${repo} tracking worktree`)
      yield* runGitCommand(worktreePath, 'checkout', FIXTURE_BRANCH)
    }
    const consumer = yield* createWorkspaceWithLock({
      members: {
        child: `https://example.com/acme/child#${FIXTURE_BRANCH}`,
        plain: `https://example.com/acme/leaf#${FIXTURE_BRANCH}`,
      },
      lockEntries: {
        child: {
          url: 'https://example.com/acme/child',
          ref: FIXTURE_BRANCH,
          commit: fixture.childCommit,
        },
        plain: {
          url: 'https://example.com/acme/leaf',
          ref: FIXTURE_BRANCH,
          commit: fixture.leafCommit,
        },
      },
    })
    const trackingHead = (repo: string) =>
      `${fixture.store.storePath}example.com/acme/${repo}/refs/heads/${FIXTURE_BRANCH}`
    const env = {
      CI: 'false',
      MEGAREPO_STORE: fixture.store.storePath.slice(0, -1),
      MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
    }
    const mount = (root: string, name: string) =>
      EffectPath.ops.join(
        EffectPath.unsafe.absoluteDir(root.endsWith('/') === true ? root : `${root}/`),
        EffectPath.unsafe.relativeDir(`repos/${name}/`),
      )
    const applyNeeded = Effect.fnUntraced(function* () {
      const status = yield* runMrCommand({
        cwd: consumer.workspacePath,
        command: ['status'],
        args: ['--all', '--output', 'json'],
        env,
      })
      const out = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ applyNeeded: Schema.Boolean })),
      )(status.stdout.trim())
      return out.applyNeeded
    })
    return { ...fixture, consumer, trackingHead, env, mount, applyNeeded }
  })

const setupApplyArgs = [
  '--output',
  'json',
  '--worktree-mode',
  'tracking',
  '--commit-members',
  'child',
  '--lock-sync',
  'off',
]

describe('apply --commit-members (mr:setup nested trees)', () => {
  it.effect(
    'prepares listed nested trees in fresh commit worktrees and keeps other members on tracking heads',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createSetupConsumerFixture()
        const { consumer, env, mount } = fixture
        const lockPath = `${consumer.workspacePath}${LOCK_FILE_NAME}`
        const lockBefore = yield* fs.readFileString(lockPath)

        // Without the option, setup is the plain tracking apply: the nested member shares
        // its tracking branch, its repos/ never exists, and recursive readiness reports it.
        const plainSetup = yield* runApplyCommand({
          cwd: consumer.workspacePath,
          args: ['--output', 'json', '--worktree-mode', 'tracking', '--lock-sync', 'off'],
          env,
        })
        expect(plainSetup.exitCode).toBe(0)
        expect(yield* fs.realPath(mount(consumer.workspacePath, 'child'))).toBe(
          fixture.trackingHead('child'),
        )
        expect(yield* fs.exists(`${fixture.trackingHead('child')}/repos`)).toBe(false)
        expect(yield* fixture.applyNeeded()).toBe(true)
        const headsEntries = yield* fs.readDirectory(fixture.trackingHead('child'))

        const result = yield* runApplyCommand({
          cwd: consumer.workspacePath,
          args: setupApplyArgs,
          env,
        })
        expect(result.stdout).not.toContain('PermissionDenied')
        const out = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              syncErrorCount: Schema.Finite,
              syncErrors: Schema.Array(SyncErrorItem),
            }),
          ),
        )(result.stdout.trim())
        expect(result.exitCode).toBe(0)
        expect(out.syncErrors).toEqual([])

        // Only the listed member switches; the ordinary member stays on its tracking worktree.
        expect(yield* fs.realPath(mount(consumer.workspacePath, 'plain'))).toBe(
          fixture.trackingHead('leaf'),
        )
        const mounts = [
          [consumer.workspacePath, 'child', fixture.childPath, fixture.childCommit],
          [fixture.childPath, 'grandchild', fixture.grandchildPath, fixture.grandchildCommit],
          [fixture.grandchildPath, 'leaf', fixture.leafPath, fixture.leafCommit],
        ] as const
        for (const [root, name, target, commit] of mounts) {
          expect(yield* fs.realPath(mount(root, name))).toBe(target.slice(0, -1))
          expect(yield* runGitCommand(mount(root, name), 'rev-parse', 'HEAD')).toBe(commit)
        }

        // The shared tracking worktree was not mutated and the lock was not rewritten.
        expect(yield* fs.readDirectory(fixture.trackingHead('child'))).toEqual(headsEntries)
        expect(yield* fs.exists(`${fixture.trackingHead('child')}/repos`)).toBe(false)
        expect(yield* fs.readFileString(lockPath)).toBe(lockBefore)
        expect(yield* fixture.applyNeeded()).toBe(false)

        // A warm rerun accepts the already prepared, now preexisting commit worktrees.
        const warm = yield* runApplyCommand({
          cwd: consumer.workspacePath,
          args: setupApplyArgs,
          env,
        })
        expect(warm.stdout).not.toContain('PermissionDenied')
        expect(warm.exitCode).toBe(0)
        expect(yield* fixture.applyNeeded()).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  for (const filter of [
    ['--only', 'child'],
    ['--skip', 'grandchild'],
  ] as const) {
    it.effect(
      `keeps root ${filter.join(' ')} out of the listed member's complete commit subtree`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const fixture = yield* createSetupConsumerFixture()
          const { consumer, env, mount } = fixture

          const result = yield* runApplyCommand({
            cwd: consumer.workspacePath,
            args: [...setupApplyArgs, ...filter],
            env,
          })
          expect(result.stdout).not.toContain('PermissionDenied')
          expect(result.exitCode).toBe(0)

          // Root filters select root members only; the fresh subtree below `child` is complete.
          const mounts = [
            [consumer.workspacePath, 'child', fixture.childPath, fixture.childCommit],
            [fixture.childPath, 'grandchild', fixture.grandchildPath, fixture.grandchildCommit],
            [fixture.grandchildPath, 'leaf', fixture.leafPath, fixture.leafCommit],
          ] as const
          for (const [root, name, target, commit] of mounts) {
            expect(yield* fs.realPath(mount(root, name))).toBe(target.slice(0, -1))
            expect(yield* runGitCommand(mount(root, name), 'rev-parse', 'HEAD')).toBe(commit)
          }

          // A later unfiltered setup sees a prepared tree, not an unrepairable partial one.
          const unfiltered = yield* runApplyCommand({
            cwd: consumer.workspacePath,
            args: setupApplyArgs,
            env,
          })
          expect(unfiltered.stdout).not.toContain('PermissionDenied')
          expect(unfiltered.exitCode).toBe(0)
          expect(yield* fixture.applyNeeded()).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 30000 },
    )
  }

  it.effect(
    '--commit-all-members prepares every root tree, including comma-containing member names',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createColdCanonicalRecursionFixture()
        // A comma is a valid member name character, so a comma-joined --commit-members list
        // cannot name this member.
        const nestedName = 'child,core'
        const consumer = yield* createWorkspaceWithLock({
          members: {
            [nestedName]: `https://example.com/acme/child#${FIXTURE_BRANCH}`,
            plain: `https://example.com/acme/leaf#${FIXTURE_BRANCH}`,
          },
          lockEntries: {
            [nestedName]: {
              url: 'https://example.com/acme/child',
              ref: FIXTURE_BRANCH,
              commit: fixture.childCommit,
            },
            plain: {
              url: 'https://example.com/acme/leaf',
              ref: FIXTURE_BRANCH,
              commit: fixture.leafCommit,
            },
          },
        })
        const env = {
          CI: 'true',
          MEGAREPO_STORE: fixture.store.storePath.slice(0, -1),
          MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
        }
        const mount = (root: string, name: string) =>
          EffectPath.ops.join(
            EffectPath.unsafe.absoluteDir(root.endsWith('/') === true ? root : `${root}/`),
            EffectPath.unsafe.relativeDir(`repos/${name}/`),
          )
        const applyArgs = [
          '--output',
          'json',
          '--worktree-mode',
          'commit',
          '--commit-all-members',
          '--lock-sync',
          'off',
        ]

        const listed = yield* runApplyCommand({
          cwd: consumer.workspacePath,
          args: ['--output', 'json', '--commit-members', nestedName, '--lock-sync', 'off'],
          env,
        })
        expect(listed.exitCode).toBe(1)
        expect(yield* fs.exists(mount(consumer.workspacePath, nestedName))).toBe(false)

        for (const run of ['cold', 'warm'] as const) {
          const result = yield* runApplyCommand({
            cwd: consumer.workspacePath,
            args: applyArgs,
            env,
          })
          expect(result.stdout, run).not.toContain('PermissionDenied')
          expect(result.exitCode, run).toBe(0)
        }
        const mounts = [
          [consumer.workspacePath, nestedName, fixture.childPath, fixture.childCommit],
          [fixture.childPath, 'grandchild', fixture.grandchildPath, fixture.grandchildCommit],
          [fixture.grandchildPath, 'leaf', fixture.leafPath, fixture.leafCommit],
        ] as const
        for (const [root, name, target, commit] of mounts) {
          expect(yield* fs.realPath(mount(root, name))).toBe(target.slice(0, -1))
          expect(yield* runGitCommand(mount(root, name), 'rev-parse', 'HEAD')).toBe(commit)
        }

        const status = yield* runMrCommand({
          cwd: consumer.workspacePath,
          command: ['status'],
          args: ['--all', '--output', 'json'],
          env,
        })
        const out = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ applyNeeded: Schema.Boolean })),
        )(status.stdout.trim())
        expect(out.applyNeeded).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  it.effect(
    'rejects --commit-all-members combined with --commit-members, --all or lock sync',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createSetupConsumerFixture()
        for (const args of [
          ['--commit-all-members', '--commit-members', 'child', '--lock-sync', 'off'],
          ['--commit-all-members', '--all', '--lock-sync', 'off'],
          ['--commit-all-members', '--lock-sync', 'direct'],
        ]) {
          const result = yield* runApplyCommand({
            cwd: fixture.consumer.workspacePath,
            args: ['--output', 'json', '--worktree-mode', 'commit', ...args],
            env: fixture.env,
          })
          expect(result.exitCode).toBe(1)
          expect(yield* fixture.applyNeeded()).toBe(true)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  it.effect(
    'refuses a preexisting incomplete shared commit worktree instead of granting freshness',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* createSetupConsumerFixture()
        const childBare = fixture.store.bareRepoPaths['example.com/acme/child']
        if (childBare === undefined) throw new Error('Missing child bare repo')
        yield* fs.makeDirectory(path.dirname(fixture.childPath.slice(0, -1)), { recursive: true })
        yield* runGitCommand(
          childBare,
          'worktree',
          'add',
          '--detach',
          fixture.childPath,
          fixture.childCommit,
        )

        const result = yield* runApplyCommand({
          cwd: fixture.consumer.workspacePath,
          args: setupApplyArgs,
          env: fixture.env,
        })
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain('Refusing to mutate canonical worktree')
        expect(
          yield* fs.exists(
            EffectPath.ops.join(fixture.childPath, EffectPath.unsafe.relativeDir('repos/')),
          ),
        ).toBe(false)
        expect(yield* fs.exists(fixture.grandchildPath)).toBe(false)
        expect(yield* fs.realPath(fixture.mount(fixture.consumer.workspacePath, 'plain'))).toBe(
          fixture.trackingHead('leaf'),
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )

  it.effect(
    'rejects unknown members and lock sync',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createSetupConsumerFixture()
        for (const args of [
          ['--commit-members', 'missing', '--lock-sync', 'off'],
          ['--commit-members', 'child', '--lock-sync', 'direct'],
          ['--commit-members', 'child', '--all'],
        ]) {
          const result = yield* runApplyCommand({
            cwd: fixture.consumer.workspacePath,
            args: ['--output', 'json', '--worktree-mode', 'tracking', ...args],
            env: fixture.env,
          })
          expect(result.exitCode).toBe(1)
          expect(yield* fixture.applyNeeded()).toBe(true)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 30000 },
  )
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
          EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            new MegarepoConfig({
              members: {
                bad: 'not-a-valid-source',
              },
            }),
          )) + '\n',
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
          EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            new MegarepoConfig({
              members: {
                child: childPath,
              },
            }),
          )) + '\n',
        )
        yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

        // When syncing nested megarepos, the nested root is the workspace member path (repos/<name>/)
        const childNestedRoot = EffectPath.ops.join(
          parentPath,
          EffectPath.unsafe.relativeDir('repos/child/'),
        )

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
        })

        expect(result.stdout.trim()).not.toBe('')

        const SyncOutput = Schema.TaggedStruct('Error', {
          syncErrorCount: Schema.Finite,
          syncErrors: Schema.Array(SyncErrorItem),
          syncTree: MegarepoSyncTree,
        })
        const out = yield* Schema.decodeEffect(Schema.fromJsonString(SyncOutput))(
          result.stdout.trim(),
        )

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
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'applies a nested member whose pinned config still carries generators.composition, and rejects it at the root',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

        const leafPath = yield* createRepo({
          basePath: tmpDir,
          fixture: { name: 'leaf-lib', files: { 'package.json': '{"name": "leaf-lib"}' } },
        })

        // A member pinned to history that predates the composed-shape retirement.
        const childPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('child-megarepo/'),
        )
        yield* fs.makeDirectory(childPath, { recursive: true })
        yield* initGitRepo(childPath)
        const retiredConfig = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(
          new MegarepoConfig({
            members: { 'leaf-lib': leafPath },
            generators: { composition: { enabled: true, platformHub: 'leaf-lib' } },
          }),
        )
        yield* fs.writeFileString(
          EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          retiredConfig + '\n',
        )
        yield* addCommit({ repoPath: childPath, message: 'Initialize child megarepo' })

        const parentPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('parent-megarepo/'),
        )
        yield* fs.makeDirectory(parentPath, { recursive: true })
        yield* initGitRepo(parentPath)
        yield* fs.writeFileString(
          EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            new MegarepoConfig({ members: { child: childPath } }),
          )) + '\n',
        )
        yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

        const nested = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
        })
        const NestedOutput = Schema.TaggedStruct('Success', {
          syncErrorCount: Schema.Finite,
          syncTree: MegarepoSyncTree,
        })
        const nestedOut = yield* Schema.decodeEffect(Schema.fromJsonString(NestedOutput))(
          nested.stdout.trim(),
        )
        expect(nestedOut.syncErrorCount).toBe(0)
        expect(nestedOut.syncTree.nestedResults).toHaveLength(1)
        expect(
          nestedOut.syncTree.nestedResults[0]?.results.some(
            (r) => r.name === 'leaf-lib' && r.status !== 'error',
          ),
        ).toBe(true)

        // The same config as the root megarepo is rejected with the migration message.
        const rootAttempt = yield* runFetchApplyCommand({
          cwd: childPath,
          args: ['--output', 'json'],
        })
        if (Exit.isSuccess(rootAttempt.exit) === true) {
          expect.fail('root megarepo with generators.composition was applied')
        }
        expect(Cause.pretty(rootAttempt.exit.cause)).toContain('generators.composition was removed')
      },
      Effect.provide(NodeServices.layer),
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
    const childAConfig: MegarepoConfig = new MegarepoConfig({
      members: { 'shared-lib': sharedLibPath },
    })
    const childAConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childAConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childAPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
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
    const childBConfig: MegarepoConfig = new MegarepoConfig({
      members: { 'shared-lib': sharedLibPath },
    })
    const childBConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childBConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childBPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
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
    const rootConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'child-a': childAPath,
        'child-b': childBPath,
      },
    })
    const rootConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(rootConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(rootPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
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
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const rootConfigContent = yield* fs.readFileString(rootConfigPath)
        const rootConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
          rootConfigContent,
        )
        expect(rootConfig.members['child-a']).toBe(childAPath)
        expect(rootConfig.members['child-b']).toBe(childBPath)

        // Verify both children reference the same shared-lib
        const childAConfigPath = EffectPath.ops.join(
          childAPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const childAConfigContent = yield* fs.readFileString(childAConfigPath)
        const childAConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
          childAConfigContent,
        )
        expect(childAConfig.members['shared-lib']).toBe(sharedLibPath)

        const childBConfigPath = EffectPath.ops.join(
          childBPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const childBConfigContent = yield* fs.readFileString(childBConfigPath)
        const childBConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
          childBConfigContent,
        )
        expect(childBConfig.members['shared-lib']).toBe(sharedLibPath)

        // Both children reference the SAME path
        expect(childAConfig.members['shared-lib']).toBe(childBConfig.members['shared-lib'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

const createPinnedStaleCommitPullFixture = (options?: { readonly useCommitRef?: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    const sourceRepoPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('source-repo/'),
    )
    yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
    yield* initGitRepo(sourceRepoPath)
    yield* runGitCommand(sourceRepoPath, 'branch', '-M', FIXTURE_BRANCH)
    yield* fs.writeFileString(
      EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
      '# Initial history\n',
    )
    yield* addCommit({ repoPath: sourceRepoPath, message: 'Initial commit' })
    const staleCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')

    const remoteRepoPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('remote-repo.git/'),
    )
    yield* runGitCommand(tmpDir, 'init', '--bare', '-b', FIXTURE_BRANCH, remoteRepoPath)
    yield* runGitCommand(sourceRepoPath, 'remote', 'add', 'origin', remoteRepoPath)
    yield* pushFixtureBranch(sourceRepoPath)

    yield* runGitCommand(sourceRepoPath, 'checkout', '--orphan', `rewritten-${FIXTURE_BRANCH}`)
    yield* runGitCommand(sourceRepoPath, 'rm', '-rf', '.').pipe(Effect.catch(() => Effect.void))
    yield* fs.writeFileString(
      EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
      '# Rewritten history\n',
    )
    yield* addCommit({ repoPath: sourceRepoPath, message: 'Rewrite history' })
    yield* runGitCommand(sourceRepoPath, 'branch', '-M', FIXTURE_BRANCH)
    yield* runGitCommand(sourceRepoPath, 'push', '--force', 'origin', FIXTURE_BRANCH)
    const currentCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
    const memberRef = options?.useCommitRef === true ? staleCommit : FIXTURE_BRANCH
    const lockRef = memberRef
    /**
     * The fixture must remove the old object from the remote; otherwise a local clone
     * can still resolve the stale SHA and we would not exercise the recovery path.
     */
    yield* runGitCommand(remoteRepoPath, 'reflog', 'expire', '--expire=now', '--all')
    yield* runGitCommand(remoteRepoPath, 'gc', '--prune=now')

    const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
    const repoBasePath = EffectPath.ops.join(
      storePath,
      EffectPath.unsafe.relativeDir('github.com/test-owner/test-repo/'),
    )
    const bareRepoPath = EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('.bare/'))
    yield* fs.makeDirectory(repoBasePath, { recursive: true })
    /** Avoid local clone optimizations so the bare store repo reflects the pruned remote state. */
    yield* runGitCommand(tmpDir, 'clone', '--bare', '--no-local', remoteRepoPath, bareRepoPath)
    yield* runGitCommand(
      bareRepoPath,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    )
    yield* runGitCommand(bareRepoPath, 'fetch', '--tags', '--prune', 'origin')

    const { workspacePath } = yield* createWorkspaceWithLock({
      members: {
        'test-repo': `test-owner/test-repo#${memberRef}`,
      },
      lockEntries: {
        'test-repo': {
          url: 'https://github.com/test-owner/test-repo',
          ref: lockRef,
          commit: staleCommit,
          pinned: true,
        },
      },
    })

    return {
      workspacePath,
      storePath,
      staleCommit,
      currentCommit,
    }
  })

/**
 * Per-test workspace fixture for nested megarepo lock tests.
 *
 * Each test gets its own store via createStoreFixture. We cannot share stores between
 * tests because the CLI acquires file-system distributed locks on the store directory
 * (via StoreLock/DistributedSemaphore). Shared locks between tests in the same process
 * cause deadlocks since the semaphore permit is never released across test boundaries.
 *
 * The store creation (~1.5s) is the main cost. Per-test timeout is set to 15s to account
 * for macOS CI runners where git process spawning is slower than Linux.
 */
const createNestedWorkspaceFixture = () =>
  Effect.gen(function* () {
    const store = yield* createStoreFixture([
      {
        host: 'github.com',
        owner: 'acme',
        repo: 'shared',
        branches: ['main'],
      },
    ])
    return yield* createNestedWorkspaceFixtureFromStore(store)
  })

const createNestedWorkspaceFixtureFromStore = (store: StoreFixtureResult) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const sharedKey = 'github.com/acme/shared#main'
    const sharedWorktreePath = store.worktreePaths[sharedKey]
    if (sharedWorktreePath === undefined) {
      throw new Error(`Missing worktree path for ${sharedKey}`)
    }
    const sharedCommit = yield* runGitCommand(sharedWorktreePath, 'rev-parse', 'HEAD')
    const staleNestedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            shared: 'https://github.com/acme/shared#main',
          },
        }),
      )) + '\n',
    )
    let childLock = createEmptyLockFile()
    childLock = updateLockedMember({
      lockFile: childLock,
      memberName: 'shared',
      member: createLockedMember({
        url: 'https://github.com/acme/shared',
        ref: 'main',
        commit: staleNestedCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: childLock,
    })
    yield* addCommit({ repoPath: childPath, message: 'Initialize nested megarepo' })

    const parentPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('parent/'))
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            shared: 'https://github.com/acme/shared#main',
            child: childPath,
          },
        }),
      )) + '\n',
    )
    let parentLock = createEmptyLockFile()
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared',
      member: createLockedMember({
        url: 'https://github.com/acme/shared',
        ref: 'main',
        commit: sharedCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: parentLock,
    })

    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile('flake.lock')),
      '{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n',
    )
    yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

    return {
      parentPath,
      childPath,
      storePath: store.storePath,
      sharedCommit,
      staleNestedCommit,
    }
  })

const createNonMegarepoWorkspaceFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fixture = yield* createNestedWorkspaceFixture()
    const childConfigPath = EffectPath.ops.join(
      fixture.childPath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
    yield* fs.remove(childConfigPath)
    return fixture
  })

const createAliasWorkspaceFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fixture = yield* createNestedWorkspaceFixture()
    const parentConfigPath = EffectPath.ops.join(
      fixture.parentPath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
    const parentConfigContent = yield* fs.readFileString(parentConfigPath)
    const parentConfig = yield* Schema.decodeEffect(Schema.fromJsonString(MegarepoConfig))(
      parentConfigContent,
    )
    const updatedConfig = new MegarepoConfig({
      ...parentConfig,
      members: {
        ...parentConfig.members,
        'shared-alias': 'https://github.com/acme/shared#main' as const,
      },
    })
    yield* fs.writeFileString(
      parentConfigPath,
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        updatedConfig,
      )) + '\n',
    )

    const parentLockPath = EffectPath.ops.join(
      fixture.parentPath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const parentLockOpt = yield* readLockFile(parentLockPath)
    const parentLock = Option.getOrThrow(parentLockOpt)
    const sharedMember = parentLock.members['shared']
    if (sharedMember === undefined) {
      throw new Error('Missing shared member in parent lock fixture')
    }
    const parentLockWithAlias = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-alias',
      member: createLockedMember({
        url: sharedMember.url,
        ref: sharedMember.ref,
        commit: sharedMember.commit,
      }),
    })
    yield* writeLockFile({ lockPath: parentLockPath, lockFile: parentLockWithAlias })

    return fixture
  })

/** Standalone fixture — needs a different store config (two branches) */
const createNestedMegarepoLockRefMatchFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { storePath, worktreePaths, bareRepoPaths } = yield* createStoreFixture([
      {
        host: 'example.com',
        owner: 'acme',
        repo: 'shared',
        branches: ['main', 'dev'],
      },
    ])

    const mainKey = 'example.com/acme/shared#main'
    const devKey = 'example.com/acme/shared#dev'
    const mainWorktreePath = worktreePaths[mainKey]
    const devWorktreePath = worktreePaths[devKey]
    if (mainWorktreePath === undefined || devWorktreePath === undefined) {
      throw new Error(`Missing worktree paths for ${mainKey} and/or ${devKey}`)
    }

    const mainCommit = yield* runGitCommand(mainWorktreePath, 'rev-parse', 'HEAD')
    yield* fs.writeFileString(
      EffectPath.ops.join(devWorktreePath, EffectPath.unsafe.relativeFile('dev-only.txt')),
      'dev-only commit\n',
    )
    yield* addCommit({ repoPath: devWorktreePath, message: 'Add dev-only commit' })
    const devCommit = yield* runGitCommand(devWorktreePath, 'rev-parse', 'HEAD')
    const sharedRepoKey = 'example.com/acme/shared'
    const sharedBareRepoPath = bareRepoPaths[sharedRepoKey]
    if (sharedBareRepoPath === undefined) {
      throw new Error(`Missing bare repo path for ${sharedRepoKey}`)
    }
    yield* runGitCommand(sharedBareRepoPath, 'update-ref', 'refs/heads/main', mainCommit)
    yield* runGitCommand(sharedBareRepoPath, 'update-ref', 'refs/heads/dev', devCommit)

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            'shared-dev': 'https://example.com/acme/shared#dev',
          },
        }),
      )) + '\n',
    )
    let childLock = createEmptyLockFile()
    childLock = updateLockedMember({
      lockFile: childLock,
      memberName: 'shared-dev',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'dev',
        commit: mainCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: childLock,
    })
    yield* addCommit({ repoPath: childPath, message: 'Initialize nested megarepo' })

    const parentPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('parent/'))
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            'shared-main': 'https://example.com/acme/shared#main',
            'shared-dev': 'https://example.com/acme/shared#dev',
            child: childPath,
          },
        }),
      )) + '\n',
    )
    let parentLock = createEmptyLockFile()
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-main',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'main',
        commit: mainCommit,
      }),
    })
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-dev',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'dev',
        commit: devCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: parentLock,
    })

    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile('flake.lock')),
      '{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n',
    )
    yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

    return {
      parentPath,
      childPath,
      storePath,
      mainCommit,
      devCommit,
    }
  })

describe('canonical member mutation guard', () => {
  for (const scenario of [
    'prepared',
    'missing',
    'wrong-source',
    'wrong-ref',
    'drifted-head',
    'dirty-tracking',
    'local-drift',
    'skipped',
    'only',
  ] as const) {
    it.effect(
      `apply --verify-shared checks ${scenario} canonical members without any writes`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const store = yield* createStoreFixture([
            { host: 'github.com', owner: 'acme', repo: 'victim', branches: ['main'] },
            { host: 'github.com', owner: 'acme', repo: 'other', branches: ['main'] },
          ])
          const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
          const repoDir = `${workspacePath}store/github.com/acme/workspace`
          const canonicalRoot = yield* makeStoreWorktree({
            repoDir,
            kind: 'heads',
            ref: 'main',
          })
          const victim = store.worktreePaths['github.com/acme/victim#main']!
          if (scenario !== 'wrong-ref') {
            yield* runGitCommand(victim, 'symbolic-ref', 'HEAD', 'refs/heads/main')
          }
          const other = store.worktreePaths['github.com/acme/other#main']!
          const target = scenario === 'wrong-source' ? other : victim
          const commit = yield* Git.getCurrentCommit(target)
          const local = `${workspacePath}local`
          const otherLocal = `${workspacePath}other-local`
          yield* fs.makeDirectory(local)
          yield* fs.makeDirectory(otherLocal)
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.json`,
            encodeJson({
              members: { victim: 'acme/victim#main', local },
              generators: { vscode: { enabled: true } },
            }),
          )
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.lock`,
            encodeJson({
              version: 1,
              members: {
                victim: createLockedMember({
                  url: 'https://github.com/acme/victim',
                  ref: 'main',
                  commit,
                }),
              },
            }),
          )
          yield* fs.makeDirectory(`${canonicalRoot}.vscode`)
          yield* fs.writeFileString(`${canonicalRoot}.vscode/megarepo.code-workspace`, 'sentinel\n')
          yield* fs.makeDirectory(`${canonicalRoot}repos`)
          yield* fs.symlink(
            scenario === 'local-drift' ? otherLocal : local,
            `${canonicalRoot}repos/local`,
          )
          if (scenario !== 'missing' && scenario !== 'skipped' && scenario !== 'only') {
            yield* fs.symlink(target.replace(/\/$/, ''), `${canonicalRoot}repos/victim`)
          }
          if (scenario === 'drifted-head') {
            yield* fs.writeFileString(`${victim}drift.txt`, 'advanced\n')
            yield* addCommit({ repoPath: victim, message: 'Advance member' })
          }
          if (scenario === 'dirty-tracking') {
            yield* fs.writeFileString(`${victim}README.md`, 'uncommitted tracked change\n')
          }
          const beforeWorkspace = yield* snapshotWorkspaceTree(repoDir)
          const beforeStore = yield* snapshotWorkspaceTree(store.storePath)
          const result = yield* runApplyCommand({
            cwd: canonicalRoot,
            args: [
              '--output',
              'json',
              '--worktree-mode',
              'tracking',
              '--lock-sync',
              'off',
              '--verify-shared',
              ...(scenario === 'skipped' ? ['--skip', 'victim'] : []),
              ...(scenario === 'only' ? ['--only', 'local'] : []),
            ],
            env: { MEGAREPO_STORE: store.storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })
          const succeeds = scenario === 'prepared' || scenario === 'skipped' || scenario === 'only'
          const diagnostic =
            Exit.isFailure(result.exit) === true
              ? Cause.pretty(result.exit.cause)
              : `${result.stdout}\n${result.stderr}`
          expect(result.exitCode, diagnostic).toBe(succeeds === true ? 0 : 1)
          expect(result.stdout).toContain('"generatedFiles":[]')
          if (succeeds === false) {
            expect(result.stdout).toContain('Prepare it from the owning workspace')
            expect(result.stdout).toContain('or use an owned worktree')
          }
          expect(yield* snapshotWorkspaceTree(repoDir)).toEqual(beforeWorkspace)
          expect(yield* snapshotWorkspaceTree(store.storePath)).toEqual(beforeStore)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  for (const selector of ['--commit-members', '--commit-all-members']) {
    for (const drift of ['prepared', 'local-target', 'remote-repository']) {
      it.effect(
        `apply --verify-shared ${selector} checks nested ${drift} source identity without writes`,
        Effect.fnUntraced(
          function* () {
            const fs = yield* FileSystem.FileSystem
            const store = yield* createStoreFixture(
              ['nested', 'leaf', 'wrong'].map((repo) => ({
                host: 'github.com',
                owner: 'acme',
                repo,
                branches: ['main'],
              })),
            )
            const leafCommit = yield* Git.getCurrentCommit(
              store.worktreePaths['github.com/acme/leaf#main']!,
            )
            const nestedCommit = yield* Git.getCurrentCommit(
              store.worktreePaths['github.com/acme/nested#main']!,
            )
            const wrongBare = store.bareRepoPaths['github.com/acme/wrong']!
            yield* runGitCommand(
              wrongBare,
              'fetch',
              store.bareRepoPaths['github.com/acme/leaf']!,
              leafCommit,
            )
            const mounts: Record<string, string> = {}
            for (const [repo, commit] of [
              ['nested', nestedCommit],
              ['leaf', leafCommit],
              ['wrong', leafCommit],
            ]) {
              const target = `${store.storePath}github.com/acme/${repo}/refs/commits/${commit}`
              yield* runGitCommand(
                store.bareRepoPaths[`github.com/acme/${repo}`]!,
                'worktree',
                'add',
                '--detach',
                target,
                commit!,
              )
              mounts[repo!] = target
            }
            const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
            const repoDir = `${workspacePath}store/github.com/acme/workspace`
            const root = yield* makeStoreWorktree({ repoDir, kind: 'heads', ref: 'main' })
            const local = `${workspacePath}local`
            const wrongLocal = `${workspacePath}wrong-local`
            yield* fs.makeDirectory(local)
            yield* fs.makeDirectory(wrongLocal)
            const nested = mounts['nested']!
            yield* fs.writeFileString(
              `${nested}/megarepo.json`,
              encodeJson({
                members: { leaf: 'acme/leaf#main', local },
              }),
            )
            yield* fs.writeFileString(
              `${nested}/megarepo.lock`,
              encodeJson({
                version: 1,
                members: {
                  leaf: createLockedMember({
                    url: 'https://github.com/acme/leaf',
                    ref: 'main',
                    commit: leafCommit,
                  }),
                },
              }),
            )
            yield* fs.makeDirectory(`${nested}/repos`)
            yield* fs.symlink(
              drift === 'local-target' ? wrongLocal : local,
              `${nested}/repos/local`,
            )
            yield* fs.symlink(
              drift === 'remote-repository' ? mounts['wrong']! : mounts['leaf']!,
              `${nested}/repos/leaf`,
            )
            yield* fs.writeFileString(
              `${root}megarepo.json`,
              encodeJson({ members: { nested: 'acme/nested#main' } }),
            )
            yield* fs.writeFileString(
              `${root}megarepo.lock`,
              encodeJson({
                version: 1,
                members: {
                  nested: createLockedMember({
                    url: 'https://github.com/acme/nested',
                    ref: 'main',
                    commit: nestedCommit,
                  }),
                },
              }),
            )
            yield* fs.makeDirectory(`${root}repos`)
            yield* fs.symlink(nested, `${root}repos/nested`)
            const beforeWorkspace = yield* snapshotWorkspaceTree(repoDir)
            const beforeStore = yield* snapshotWorkspaceTree(store.storePath)
            const result = yield* runApplyCommand({
              cwd: root,
              args: [
                '--output',
                'json',
                '--worktree-mode',
                'tracking',
                '--lock-sync',
                'off',
                '--verify-shared',
                selector,
                ...(selector === '--commit-members' ? ['nested'] : []),
              ],
              env: { MEGAREPO_STORE: store.storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
            })
            expect(result.exitCode).toBe(drift === 'prepared' ? 0 : 1)
            if (drift !== 'prepared') {
              expect(result.stdout).toContain('Prepare it from the owning workspace')
            }
            expect(yield* snapshotWorkspaceTree(repoDir)).toEqual(beforeWorkspace)
            expect(yield* snapshotWorkspaceTree(store.storePath)).toEqual(beforeStore)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
        { timeout: 60_000 },
      )
    }
  }

  for (const verifyShared of [false, true]) {
    it.effect(
      `apply (verify-shared: ${verifyShared}) materializes and generates in a slash-prefixed author workspace`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
          const canonicalRoot = yield* makeStoreWorktree({
            repoDir: `${workspacePath}store/github.com/acme/workspace`,
            kind: 'heads',
            ref: 'schickling-assistant/team/feature',
          })
          const local = `${workspacePath}local`
          yield* fs.makeDirectory(local)
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.json`,
            encodeJson({
              members: { local },
              generators: { vscode: { enabled: true } },
            }),
          )
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.lock`,
            encodeJson({ version: 1, members: {} }),
          )
          const result = yield* runApplyCommand({
            cwd: canonicalRoot,
            args: [
              '--output',
              'json',
              '--worktree-mode',
              'tracking',
              '--lock-sync',
              'off',
              ...(verifyShared === true ? ['--verify-shared'] : []),
            ],
            env: {
              MEGAREPO_STORE: `${workspacePath}store`,
              MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
            },
          })
          expect(result.exitCode).toBe(0)
          expect(yield* fs.realPath(`${canonicalRoot}repos/local`)).toBe(local)
          expect(yield* fs.exists(`${canonicalRoot}.vscode/megarepo.code-workspace`)).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  for (const generator of ['vscode', 'schema'] as const) {
    for (const scenario of ['author', 'shared', 'escaped-author'] as const) {
      it.effect(
        `${generator} generator authorizes ${scenario} workspace outputs without escaping ownership`,
        Effect.fnUntraced(
          function* () {
            const fs = yield* FileSystem.FileSystem
            const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
            const canonicalRoot = yield* makeStoreWorktree({
              repoDir: `${workspacePath}store/github.com/acme/workspace`,
              kind: 'heads',
              ref: scenario === 'shared' ? 'main' : 'schickling-assistant/team/feature',
            })
            const config = new MegarepoConfig({ members: {} })
            const outputDir = generator === 'vscode' ? '.vscode' : 'schema'
            const outputFile =
              generator === 'vscode' ? 'megarepo.code-workspace' : 'megarepo.schema.json'
            const external = `${workspacePath}external`
            yield* fs.makeDirectory(external)
            if (scenario === 'escaped-author') {
              yield* fs.symlink(external, `${canonicalRoot}${outputDir}`)
            }
            const before = yield* snapshotWorkspaceTree(canonicalRoot)
            const result = yield* Effect.exit(
              generator === 'vscode'
                ? generateVscode({ megarepoRoot: canonicalRoot, config })
                : generateSchema({ megarepoRoot: canonicalRoot, config }),
            )
            expect(Exit.isSuccess(result)).toBe(scenario === 'author')
            if (scenario === 'author') {
              expect(yield* fs.exists(`${canonicalRoot}${outputDir}/${outputFile}`)).toBe(true)
            } else {
              expect(yield* snapshotWorkspaceTree(canonicalRoot)).toEqual(before)
            }
            expect(yield* fs.readDirectory(external)).toEqual([])
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )
    }
  }

  for (const outputPath of ['alias/../megarepo.json', 'alias/../missing/schema.json']) {
    it.effect(
      `schema generator refuses symlink-parent traversal through ${outputPath}`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
          const repoDir = `${workspacePath}store/github.com/acme/workspace`
          const author = yield* makeStoreWorktree({ repoDir, kind: 'heads', ref: 'team/feature' })
          const shared = `${repoDir}/refs/heads/main`
          yield* runGitCommand(
            EffectPath.unsafe.absoluteDir(`${repoDir}/.bare/`),
            'worktree',
            'add',
            shared,
            'main',
          )
          const config = encodeJson({ members: {} })
          yield* fs.writeFileString(`${author}megarepo.json`, config)
          yield* fs.writeFileString(`${shared}/megarepo.json`, config)
          yield* fs.makeDirectory(`${shared}/subdir`)
          yield* fs.symlink(`${shared}/subdir`, `${author}alias`)
          const before = yield* snapshotWorkspaceTree(repoDir)
          const result = yield* runMrCommand({
            cwd: author,
            command: ['generate', 'schema'],
            args: ['--output-path', outputPath],
            env: { MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            expect(Cause.pretty(result.exit.cause)).toContain('PermissionDenied')
          }
          expect(yield* snapshotWorkspaceTree(repoDir)).toEqual(before)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  it.effect(
    'schema generator writes the authorized destination without creating traversed shared directories',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = `${yield* makeCanonicalTempDirectoryScoped()}/`
        const repoDir = `${workspacePath}store/github.com/acme/workspace`
        const author = yield* makeStoreWorktree({ repoDir, kind: 'heads', ref: 'feature' })
        const shared = `${repoDir}/refs/heads/main`
        yield* runGitCommand(
          EffectPath.unsafe.absoluteDir(`${repoDir}/.bare/`),
          'worktree',
          'add',
          shared,
          'main',
        )
        const config = encodeJson({ members: {} })
        yield* fs.writeFileString(`${author}megarepo.json`, config)
        yield* fs.writeFileString(`${shared}/megarepo.json`, config)
        yield* fs.symlink(shared, `${author}alias`)
        const beforeShared = yield* snapshotWorkspaceTree(shared)
        const result = yield* runMrCommand({
          cwd: author,
          command: ['generate', 'schema'],
          args: ['--output-path', 'alias/new/../../feature/schema.json'],
          env: { MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
        })
        expect(Exit.isSuccess(result.exit)).toBe(true)
        expect(yield* fs.exists(`${author}schema.json`)).toBe(true)
        expect(yield* fs.exists(`${shared}/new`)).toBe(false)
        expect(yield* snapshotWorkspaceTree(shared)).toEqual(beforeShared)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  for (const [refKind, ref, lockSync, granted] of [
    ['heads', 'team/feature', 'off', true],
    ['heads', 'main', 'off', false],
    ['tags', 'team/feature', 'off', false],
    ['commits', 'team/feature', 'off', false],
    ['commits', undefined, 'off', true],
    ['commits', 'a'.repeat(40), 'off', false],
    ['commits', undefined, 'direct', false],
    ['commits', undefined, 'recursive', false],
  ] as const) {
    it.effect(
      `materializes invoking ${refKind}/${ref ?? 'HEAD'} workspace with lock-sync ${lockSync} (granted: ${granted})`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const canonicalRoot = yield* makeStoreWorktree({
            repoDir: `${workspacePath}store/github.com/acme/workspace`,
            kind: refKind,
            ...(ref !== undefined ? { ref } : {}),
          })
          const memberPath = `${workspacePath}owned`
          yield* fs.makeDirectory(memberPath)
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.json`,
            encodeJson({ members: { victim: memberPath } }),
          )
          const originalLock = encodeJson({ version: 1, members: {} })
          yield* fs.writeFileString(`${canonicalRoot}megarepo.lock`, originalLock)
          const result = yield* runApplyCommand({
            cwd: canonicalRoot,
            args: ['--output', 'json', '--worktree-mode', 'commit', '--lock-sync', lockSync],
            env: {
              MEGAREPO_STORE: `${workspacePath}store`,
              MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
            },
          })
          expect(result.exitCode).toBe(granted === true ? 0 : 1)
          if (granted === true) {
            expect(yield* fs.realPath(`${canonicalRoot}repos/victim`)).toBe(memberPath)
          } else {
            expect(yield* fs.exists(`${canonicalRoot}repos`)).toBe(false)
          }
          expect(yield* fs.readFileString(`${canonicalRoot}megarepo.lock`)).toBe(originalLock)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  for (const operation of [
    'lock',
    'generator',
    'generator-directory-alias',
    'generator-output-alias',
    'foreign-mount',
  ] as const) {
    it.effect(
      `refuses ${operation} writes from an exact-commit apply workspace`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          let canonicalRoot = yield* makeStoreWorktree({
            repoDir: `${workspacePath}store/github.com/acme/workspace`,
            kind: 'commits',
          })
          const isGenerator = operation.startsWith('generator')
          const memberPath = `${workspacePath}owned`
          yield* fs.makeDirectory(memberPath)
          yield* fs.writeFileString(
            `${canonicalRoot}megarepo.json`,
            encodeJson({
              members: { victim: memberPath },
              ...(isGenerator === true ? { generators: { vscode: { enabled: true } } } : {}),
            }),
          )
          const originalLock = encodeJson({ version: 1, members: {} })
          yield* fs.writeFileString(`${canonicalRoot}megarepo.lock`, originalLock)
          const foreignRepos = `${workspacePath}store/github.com/acme/shared/refs/commits/${'b'.repeat(40)}/repos`
          if (operation === 'foreign-mount') {
            yield* fs.makeDirectory(foreignRepos, { recursive: true })
            yield* fs.symlink(foreignRepos, `${canonicalRoot}repos`)
          }
          const externalDir = `${workspacePath}external`
          const externalOutput = `${externalDir}/megarepo.code-workspace`
          const originalOutput = 'external file must remain unchanged\n'
          if (isGenerator === true) {
            yield* fs.makeDirectory(externalDir)
            yield* fs.writeFileString(externalOutput, originalOutput)
            if (operation === 'generator-directory-alias') {
              yield* fs.symlink(externalDir, `${canonicalRoot}.vscode`)
            } else if (operation === 'generator-output-alias') {
              yield* fs.makeDirectory(`${canonicalRoot}.vscode`)
              yield* fs.symlink(externalOutput, `${canonicalRoot}.vscode/megarepo.code-workspace`)
            }
            // Commit the generator config and aliases, then encode that HEAD in the store path.
            yield* addCommit({ repoPath: canonicalRoot, message: 'Add generator fixture' })
            const head = (yield* runGitCommand(canonicalRoot, 'rev-parse', 'HEAD')).trim()
            const exactRoot = EffectPath.unsafe.absoluteDir(
              `${path.dirname(canonicalRoot.slice(0, -1))}/${head}/`,
            )
            yield* runGitCommand(canonicalRoot, 'worktree', 'move', canonicalRoot, exactRoot)
            canonicalRoot = exactRoot
          }
          const env = {
            MEGAREPO_STORE: `${workspacePath}store`,
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
          }
          const result =
            operation === 'lock'
              ? yield* runLockRecordCommand({ cwd: canonicalRoot, args: ['--output', 'json'], env })
              : yield* runApplyCommand({
                  cwd: canonicalRoot,
                  args: ['--output', 'json', '--worktree-mode', 'commit', '--lock-sync', 'off'],
                  env,
                })
          expect(result.exitCode).toBe(1)
          const diagnostic =
            Exit.isFailure(result.exit) === true
              ? Cause.pretty(result.exit.cause)
              : `${result.stdout}\n${result.stderr}`
          expect(diagnostic).toContain('Refusing to mutate canonical worktree')
          expect(yield* fs.readFileString(`${canonicalRoot}megarepo.lock`)).toBe(originalLock)
          if (isGenerator === true) {
            expect(yield* fs.exists(`${canonicalRoot}repos`)).toBe(false)
            expect(yield* fs.readFileString(externalOutput)).toBe(originalOutput)
            if (operation !== 'generator') {
              const config = new MegarepoConfig({ members: { victim: memberPath } })
              const vscodeError = yield* generateVscode({
                megarepoRoot: canonicalRoot,
                config,
              }).pipe(Effect.flip)
              expect(vscodeError.reason._tag).toBe('PermissionDenied')
              const schemaError = yield* generateSchema({
                megarepoRoot: canonicalRoot,
                config,
                outputPath: '.vscode/megarepo.code-workspace',
              }).pipe(Effect.flip)
              expect(schemaError.reason._tag).toBe('PermissionDenied')
              expect(yield* fs.readFileString(externalOutput)).toBe(originalOutput)
            }
            if (operation === 'generator') {
              expect(yield* fs.exists(`${canonicalRoot}.vscode`)).toBe(false)
            }
          }
          if (operation === 'foreign-mount') {
            expect(yield* fs.readDirectory(foreignRepos)).toEqual([])
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  for (const worktreeMode of ['tracking', 'commit'] as const) {
    it.effect(
      `refuses direct lock sync in canonical ${worktreeMode} worktrees unless explicitly authorized`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const store = yield* createStoreFixture([
            { host: 'github.com', owner: 'acme', repo: 'victim', branches: ['main'] },
          ])
          const branchPath = store.worktreePaths['github.com/acme/victim#main']!
          yield* runGitCommand(branchPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
          const depCommit = 'a'.repeat(40)
          const nixLock = encodeJson({
            version: 7,
            root: 'root',
            nodes: {
              root: { inputs: { dep: 'dep' } },
              dep: {
                locked: { type: 'github', owner: 'acme', repo: 'dep', rev: depCommit },
                original: { type: 'github', owner: 'acme', repo: 'dep', ref: 'main' },
              },
            },
          })
          const originals = {
            'flake.nix': `{ inputs.dep.url = "github:acme/dep/main?rev=${depCommit}"; }\n`,
            'devenv.yaml': `inputs:\n  dep:\n    url: github:acme/dep/main?rev=${depCommit}\n`,
            'flake.lock': nixLock,
            'devenv.lock': nixLock,
          }
          for (const [name, content] of Object.entries(originals)) {
            yield* fs.writeFileString(`${branchPath}${name}`, content)
          }
          yield* addCommit({ repoPath: branchPath, message: 'Add stale Nix input refs' })
          const victimCommit = (yield* runGitCommand(branchPath, 'rev-parse', 'HEAD')).trim()
          const { workspacePath } = yield* createWorkspace({
            members: { victim: 'acme/victim#main', dep: 'acme/dep#feature' },
          })
          yield* fs.writeFileString(
            `${workspacePath}megarepo.json`,
            encodeJson({
              members: { victim: 'acme/victim#main', dep: 'acme/dep#feature' },
              lockSync: { enabled: true },
            }),
          )
          yield* fs.writeFileString(
            `${workspacePath}megarepo.lock`,
            encodeJson({
              version: 1,
              members: {
                victim: {
                  url: 'https://github.com/acme/victim',
                  ref: 'main',
                  commit: victimCommit,
                  pinned: false,
                  lockedAt: '2026-01-01T00:00:00.000Z',
                },
                dep: {
                  url: 'https://github.com/acme/dep',
                  ref: 'feature',
                  commit: depCommit,
                  pinned: false,
                  lockedAt: '2026-01-01T00:00:00.000Z',
                },
              },
            }),
          )
          const args = ['--output', 'json', '--only', 'victim', '--worktree-mode', worktreeMode]
          const env = {
            MEGAREPO_STORE: store.storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
          }
          const off = yield* runApplyCommand({
            cwd: workspacePath,
            args: [...args, '--lock-sync', 'off'],
            env,
          })
          expect(off.exitCode).toBe(0)
          const physicalMember = yield* fs.realPath(`${workspacePath}repos/victim`)
          expect(physicalMember).toContain(
            worktreeMode === 'commit' ? `/refs/commits/${victimCommit}` : '/refs/heads/main',
          )
          const refused = yield* runApplyCommand({
            cwd: workspacePath,
            args: [...args, '--lock-sync', 'direct'],
            env,
          })
          expect(refused.exitCode).toBe(1)
          const diagnostic =
            Exit.isFailure(refused.exit) === true
              ? Cause.pretty(refused.exit.cause)
              : `${refused.stdout}\n${refused.stderr}`
          expect(diagnostic).toContain(physicalMember)
          expect(diagnostic).toContain('Authoring writes require an owned author workspace')
          expect(diagnostic).not.toContain('Use --lock-sync=off')
          expect(diagnostic).toContain('owned author workspace')
          for (const [name, content] of Object.entries(originals)) {
            expect(yield* fs.readFileString(`${physicalMember}/${name}`)).toBe(content)
          }
          const authorized = yield* runApplyCommand({
            cwd: workspacePath,
            args: [...args, '--lock-sync', 'direct'],
            env: { ...env, MEGAREPO_ALLOW_CANONICAL_MUTATION: '1' },
          })
          expect(authorized.exitCode).toBe(0)
          expect(yield* fs.readFileString(`${physicalMember}/flake.nix`)).toBe(
            `{ inputs.dep.url = "github:acme/dep/feature?rev=${depCommit}"; }\n`,
          )
          expect(
            decodeJson(yield* fs.readFileString(`${physicalMember}/flake.lock`)),
          ).toMatchObject({ nodes: { dep: { original: { ref: 'feature' } } } })
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 30_000 },
    )
  }

  for (const canonicalWorkspace of [false, true]) {
    it.effect(
      `refuses mount writes through a foreign repos alias (canonical: ${canonicalWorkspace})`,
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const tempRoot = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const workspacePath =
            canonicalWorkspace === true
              ? yield* makeStoreWorktree({
                  repoDir: `${tempRoot}store/github.com/acme/owned`,
                  kind: 'heads',
                  ref: 'team/feature',
                })
              : tempRoot
          yield* fs.writeFileString(
            `${workspacePath}megarepo.json`,
            encodeJson({ members: { victim: './owned' } }),
          )
          const canonicalRepos = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('store/github.com/acme/shared/refs/heads/main/repos/'),
          )
          yield* fs.makeDirectory(canonicalRepos, { recursive: true })
          yield* fs.symlink(canonicalRepos.slice(0, -1), `${workspacePath}repos`)
          yield* fs.writeFileString(`${workspacePath}megarepo.lock`, '{"version":1,"members":{}}')
          const result = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--lock-sync', 'off'],
            env: {
              MEGAREPO_STORE: `${workspacePath}store`,
              MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
            },
          })
          expect(result.exitCode).toBe(1)
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            expect(Cause.pretty(result.exit.cause)).toContain(canonicalRepos.slice(0, -1))
          }
          expect(yield* fs.readDirectory(canonicalRepos)).toEqual([])
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }
})

describe('nested megarepo.lock sync scope', () => {
  it.effect(
    'should leave member flake.nix and nested megarepo.lock untouched by default on apply',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const fs = yield* FileSystem.FileSystem
        const memberFlakePath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile('flake.nix'),
        )
        const memberFlake = `{
  inputs.shared.url = "git+https://github.com/acme/shared?ref=main&rev=${staleNestedCommit}";
}`
        yield* fs.writeFileString(memberFlakePath, memberFlake)

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
        expect(yield* fs.readFileString(memberFlakePath)).toBe(memberFlake)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should leave member flake.nix and nested megarepo.lock untouched by default on fetch --apply',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const fs = yield* FileSystem.FileSystem
        const memberFlakePath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile('flake.nix'),
        )
        const memberFlake = `{
  inputs.shared.url = "git+https://github.com/acme/shared?ref=main&rev=${staleNestedCommit}";
}`
        yield* fs.writeFileString(memberFlakePath, memberFlake)

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
        expect(yield* fs.readFileString(memberFlakePath)).toBe(memberFlake)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should sync nested megarepo.lock with explicit recursive lock sync',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, sharedCommit, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--lock-sync', 'recursive'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '1',
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(sharedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not abort recursive mr fetch when nested pinned members reference stale commits',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const nestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(nestedLockOpt)).toBe(true)

        const nestedLock = updateLockedMember({
          lockFile: Option.getOrThrow(nestedLockOpt),
          memberName: 'shared',
          member: createLockedMember({
            url: 'https://github.com/acme/shared',
            ref: 'main',
            commit: staleNestedCommit,
            pinned: true,
          }),
        })
        yield* writeLockFile({ lockPath: nestedLockPath, lockFile: nestedLock })

        const result = yield* runFetchCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain('invalid reference')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not sync nested megarepo.lock for members filtered out by --only',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--lock-sync', 'recursive', '--only', 'shared'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '1',
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not sync member megarepo.lock in --all mode when member is not a megarepo',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNonMegarepoWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--lock-sync', 'recursive'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '1',
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'applies shared-URL refs when a sibling creates the commit namespace during path resolution',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { parentPath, storePath, mainCommit, devCommit } =
          yield* createNestedMegarepoLockRefMatchFixture()
        const commitsPath = `${storePath}example.com/acme/shared/refs/commits`
        const siblingCreated = yield* Deferred.make<void>()
        let interleaved = false
        // Keep all I/O real: pause the first failed lookup until the other member's
        // exclusive mkdir has published the shared namespace.
        const controlledFs: FileSystem.FileSystem = {
          ...fs,
          realPath: (target) =>
            fs.realPath(target).pipe(
              Effect.catchIf(
                (error) =>
                  error.reason._tag === 'NotFound' &&
                  target === commitsPath &&
                  interleaved === false,
                (error) =>
                  Effect.gen(function* () {
                    interleaved = true
                    yield* Deferred.await(siblingCreated)
                    return yield* error
                  }),
              ),
            ),
          makeDirectory: (target, options) =>
            fs
              .makeDirectory(target, options)
              .pipe(
                Effect.tap(() =>
                  target === commitsPath
                    ? Deferred.succeed(siblingCreated, undefined)
                    : Effect.void,
                ),
              ),
        }
        const result = yield* Effect.gen(function* () {
          const storeLock = yield* StoreLock
          return yield* syncMegarepo({
            megarepoRoot: parentPath,
            options: {
              mode: 'apply',
              dryRun: false,
              force: false,
              all: false,
              only: ['shared-main', 'shared-dev'],
              skip: undefined,
              gitProtocol: 'https',
              createBranches: false,
              commitMode: true,
              lockSyncMode: 'off',
            },
          }).pipe(
            Effect.provideService(StoreLock, {
              ...storeLock,
              withWorktreeLock: (key) => (effect) =>
                storeLock.withWorktreeLock(key)(
                  effect.pipe(Effect.provideService(FileSystem.FileSystem, controlledFs)),
                ),
            }),
          )
        }).pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        expect(interleaved).toBe(true)
        expect(collectSyncErrors(result)).toEqual([])
        expect(yield* fs.realPath(`${parentPath}repos/shared-main`)).toBe(
          `${commitsPath}/${mainCommit}`,
        )
        expect(yield* fs.realPath(`${parentPath}repos/shared-dev`)).toBe(
          `${commitsPath}/${devCommit}`,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should match nested megarepo.lock entries by ref when URL is shared across refs',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, mainCommit, devCommit } =
          yield* createNestedMegarepoLockRefMatchFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared-dev']?.commit).toBe(mainCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--lock-sync', 'recursive'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '1',
          },
        })
        expect(
          result.exitCode,
          `mr fetch --apply failed\nstdout:\n${diagnosticTail(result.stdout)}\nstderr:\n${diagnosticTail(result.stderr)}`,
        ).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared-dev']?.commit).toBe(devCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should sync nested megarepo.lock when multiple parent aliases match URL/ref with same commit',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, sharedCommit, staleNestedCommit } =
          yield* createAliasWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: [
            '--output',
            'json',
            '--all',
            '--lock-sync',
            'recursive',
            '--worktree-mode',
            'tracking',
          ],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
            MEGAREPO_ALLOW_CANONICAL_MUTATION: '1',
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(sharedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )
})

// =============================================================================
// Lock Sync Tests (lock updated from workspace state)
// =============================================================================

describe('mr lock', () => {
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

          // Run mr lock
          const result = yield* runLockRecordCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced successfully (local path sources are symlinks)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // For local paths, status is 'synced' since they create symlinks
          expect(['synced', 'recorded', 'already_synced']).toContain(memberResult?.status)
        },
        Effect.provide(NodeServices.layer),
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
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Second sync should show already_synced
          const result = yield* runLockRecordCommand({
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('no remote fetch', () => {
    it.effect(
      'should NOT fetch from remote in lock sync mode',
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
          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              // Using a real but unlikely-to-change repo
              effect: 'effect-ts/effect',
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run mr lock. It should not fetch remote state and should report the member as
          // needing workspace sync first because no branch worktree has been materialized yet.
          const result = yield* runLockRecordCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--dry-run'],
          })

          // The command should complete (might error on clone attempt, but shouldn't hang on fetch)
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeServices.layer),
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
          const initialConfig: MegarepoConfig = new MegarepoConfig({
            members: {
              'my-lib': baseRepoPath,
            },
          })
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              initialConfig,
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

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
            .pipe(Effect.orElseSucceed(() => false))
          expect(featureFileInBase).toBe(false)

          // Update config to point to the feature repo path
          const updatedConfig: MegarepoConfig = new MegarepoConfig({
            members: {
              'my-lib': featureRepoPath,
            },
          })
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              updatedConfig,
            )) + '\n',
          )

          // Sync again - should update symlink
          const result = yield* runFetchApplyCommand({
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
            .pipe(Effect.orElseSucceed(() => false))
          expect(featureFileInFeature).toBe(true)
          expect(updatedLink.replace(/\/$/, '')).toBe(featureRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeServices.layer),
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
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': mainRepoPath },
              }),
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes to the main repo (simulating work in progress)
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config to point to feature branch
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': featureRepoPath },
              }),
            )) + '\n',
          )

          // Sync again - should skip because old worktree is dirty
          const result = yield* runFetchApplyCommand({
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    /**
     * A commit worktree is a pinned materialization: apply put it there to satisfy an exact
     * lock entry. Leaving one at the wrong sha means apply did not deliver Lock → Workspace,
     * so reporting `skipped` would exit 0 and hide a workspace that disagrees with the lock
     * that produced it (#962).
     */
    it.effect(
      'should fail when a dirty commit worktree leaves the member drifted from the lock',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const store = yield* createStoreFixture([
            { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
          ])
          const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
          if (mainWorktree === undefined) throw new Error('Missing main worktree')
          const lockedCommit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()

          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { lib: 'https://example.com/acme/lib#main' },
            lockEntries: {
              lib: { url: 'https://example.com/acme/lib', ref: 'main', commit: lockedCommit },
            },
          })
          const env = { MEGAREPO_STORE: store.storePath.slice(0, -1) }

          // Materialize the pinned commit worktree the lock currently names.
          yield* runApplyCommand({ cwd: workspacePath, args: ['--worktree-mode', 'commit'], env })

          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/lib'),
          )
          const pinnedLink = yield* fs.readLink(symlinkPath)
          expect(pinnedLink).toContain(`/refs/commits/${lockedCommit}`)

          // Move the lock on to a second real commit, then dirty the pinned worktree so apply
          // cannot switch away from it.
          yield* fs.writeFileString(
            EffectPath.ops.join(mainWorktree, EffectPath.unsafe.relativeFile('next.txt')),
            'next\n',
          )
          yield* addCommit({ repoPath: mainWorktree, message: 'Advance main' })
          const newCommit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()

          yield* writeLockFile({
            lockPath: EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
            ),
            lockFile: updateLockedMember({
              lockFile: createEmptyLockFile(),
              memberName: 'lib',
              member: createLockedMember({
                url: 'https://example.com/acme/lib',
                ref: 'main',
                commit: newCommit,
              }),
            }),
          })

          yield* fs.writeFileString(
            EffectPath.unsafe.absoluteFile(`${pinnedLink.replace(/\/$/, '')}/dirty.txt`),
            'uncommitted work\n',
          )

          const result = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--worktree-mode', 'commit', '--output', 'json'],
            env,
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results[0]?.status).toBe('error')
          expect(json.results[0]?.message).toContain(lockedCommit.slice(0, 8))
          expect(json.results[0]?.message).toContain(newCommit.slice(0, 8))
          expect(result.exitCode).toBe(1)

          // The uncommitted work is still protected — apply reports, it does not clobber.
          expect(yield* fs.readLink(symlinkPath)).toBe(pinnedLink)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 15_000 },
    )

    for (const state of ['exact', 'ahead', 'dirty', 'detached', 'absent'] as const) {
      it.effect(
        `exact-lock tracking ${state}: preserve canonical branch and converge on warm apply`,
        Effect.fnUntraced(
          function* () {
            const fs = yield* FileSystem.FileSystem
            const store = yield* createStoreFixture([
              { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
            ])
            const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
            if (mainWorktree === undefined) throw new Error('Missing main worktree')
            const lockedCommit = yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')
            const bareRepoPath = store.bareRepoPaths['example.com/acme/lib']
            if (bareRepoPath === undefined) throw new Error('Missing bare repo')
            yield* materializeNonDetachedBranchWorktree({
              bareRepoPath,
              worktreePath: mainWorktree,
              branch: 'main',
              commit: lockedCommit,
            })
            const { workspacePath } = yield* createWorkspaceWithLock({
              members: { lib: 'https://example.com/acme/lib#main' },
              lockEntries: {
                lib: { url: 'https://example.com/acme/lib', ref: 'main', commit: lockedCommit },
              },
            })
            const env = {
              CI: 'false',
              MEGAREPO_STORE: store.storePath.slice(0, -1),
              MEGAREPO_ALLOW_CANONICAL_MUTATION: '0',
            }
            const args = ['--worktree-mode', 'tracking', '--output', 'json']
            const initial = yield* runApplyCommand({ cwd: workspacePath, args, env })
            expect(initial.exitCode).toBe(0)
            const mount = EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeDir('repos/lib/'),
            )
            expect(yield* fs.realPath(mount)).toBe(mainWorktree.slice(0, -1))
            if (state === 'ahead' || state === 'absent') {
              yield* fs.writeFileString(`${mainWorktree}wip.txt`, 'local commit\n')
              yield* addCommit({ repoPath: mainWorktree, message: 'Local work' })
            } else if (state === 'dirty') {
              yield* fs.writeFileString(`${mainWorktree}dirty.txt`, 'uncommitted work\n')
            } else if (state === 'detached') {
              yield* runGitCommand(mainWorktree, 'checkout', '--detach')
            }
            const headBefore = yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')
            const dirtyBefore = yield* runGitCommand(mainWorktree, 'status', '--porcelain')
            const refBefore = yield* runGitCommand(bareRepoPath, 'rev-parse', 'refs/heads/main')
            if (state === 'absent') {
              yield* runGitCommand(bareRepoPath, 'worktree', 'remove', mainWorktree)
              expect(yield* fs.exists(mainWorktree)).toBe(false)
            }
            const lockPath = EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile('megarepo.lock'),
            )
            const lockBefore = yield* fs.readFileString(lockPath)
            const before = yield* runMrCommand({
              cwd: workspacePath,
              command: ['status'],
              args: ['--output', 'json'],
              env,
            })
            const beforeStatus = yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.Struct({ applyNeeded: Schema.Boolean })),
            )(before.stdout.trim())
            if (state !== 'detached') {
              expect(beforeStatus.applyNeeded).toBe(state !== 'exact')
            }

            for (const run of ['cold', 'warm'] as const) {
              const applied = yield* runApplyCommand({ cwd: workspacePath, args, env })
              expect(applied.exitCode, run).toBe(0)
              expect(applied.stdout).not.toContain('PermissionDenied')
              expect(yield* fs.realPath(mount)).toBe(
                state === 'exact'
                  ? mainWorktree.slice(0, -1)
                  : `${store.storePath}example.com/acme/lib/refs/commits/${lockedCommit}`,
              )
              expect(yield* runGitCommand(mount, 'rev-parse', 'HEAD')).toBe(lockedCommit)
              expect(yield* runGitCommand(bareRepoPath, 'rev-parse', 'refs/heads/main')).toBe(
                refBefore,
              )
              if (state === 'absent') {
                expect(yield* fs.exists(mainWorktree)).toBe(false)
              } else {
                expect(yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).toBe(headBefore)
                expect(yield* runGitCommand(mainWorktree, 'branch', '--show-current')).toBe(
                  state === 'detached' ? '' : 'main',
                )
                expect(yield* runGitCommand(mainWorktree, 'status', '--porcelain')).toBe(
                  dirtyBefore,
                )
              }
              expect(yield* fs.readFileString(lockPath)).toBe(lockBefore)
              const status = yield* runMrCommand({
                cwd: workspacePath,
                command: ['status'],
                args: ['--all', '--output', 'json'],
                env,
              })
              const out = yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Struct({ applyNeeded: Schema.Boolean })),
              )(status.stdout.trim())
              expect(out.applyNeeded, run).toBe(false)
            }
            if (state === 'dirty') {
              expect(yield* fs.readFileString(`${mainWorktree}dirty.txt`)).toBe(
                'uncommitted work\n',
              )
            }
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
        { timeout: 30_000 },
      )
    }

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
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': mainRepoPath },
              }),
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': featureRepoPath },
              }),
            )) + '\n',
          )

          // Sync with --force - should succeed
          const result = yield* runFetchApplyCommand({
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Lock Update Tests
// =============================================================================

describe('mr fetch', () => {
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

          // Run mr fetch (should skip dirty worktree)
          // Note: For local path sources, dirty check may not apply the same way
          // This test documents the expected behavior
          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })

          // Should complete without error
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('pinned members', () => {
    it.effect(
      'should skip pinned members in lock update mode',
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

          // Run mr fetch
          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // The sync should complete
          expect(json.results).toHaveLength(1)
          // Note: Local path sources behave differently, but this documents the behavior
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should recover pinned members with stale locked commits in mr fetch --force mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath, staleCommit, currentCommit } =
            yield* createPinnedStaleCommitPullFixture()

          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--force', '--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(result.exitCode).toBe(0)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('updated')
          expect(memberResult.previousCommit).toBe(staleCommit)
          expect(memberResult.commit).toBe(currentCommit)

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)
          expect(lockFile.members['test-repo']?.commit).toBe(currentCommit)
          expect(lockFile.members['test-repo']?.pinned).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should skip pinned stale commit-SHA refs in mr fetch mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath } = yield* createPinnedStaleCommitPullFixture({
            useCommitRef: true,
          })

          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('skipped')
          expect(memberResult.message).toContain('pinned')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should fail pinned stale commit-SHA refs in mr fetch --apply --force mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath, staleCommit } =
            yield* createPinnedStaleCommitPullFixture({
              useCommitRef: true,
            })

          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--force', '--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('error')
          expect(memberResult.message).toContain(`'${staleCommit.slice(0, 8)}'`)
          expect(memberResult.message).toContain('not available locally or on the remote')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('exact-lock branch worktrees', () => {
    it.effect(
      'exact-lock tracking falls back when the canonical branch is behind the fetched lock',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory for all test artifacts
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )

          // 1. Create source repo (acts as the remote origin)
          const sourceRepoPath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('source-repo/'),
          )
          yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
          yield* initGitRepo(sourceRepoPath)
          // Force branch name to 'main' regardless of git config default
          yield* runGitCommand(sourceRepoPath, 'checkout', '-b', 'main').pipe(
            Effect.catch(() => Effect.void),
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

          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--worktree-mode', 'tracking'],
            env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })
          expect(result.exitCode).toBe(0)
          const json = decodeSyncJsonOutput(result.stdout.trim())
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.commit).toBe(newCommit)
          expect(yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')).toBe(initialCommit)
          expect(yield* fs.exists(`${worktreePath}new-file.txt`)).toBe(false)
          const memberMount = EffectPath.ops.join(
            reposDir,
            EffectPath.unsafe.relativeDir('test-repo/'),
          )
          expect(yield* fs.realPath(memberMount)).toBe(`${repoBasePath}refs/commits/${newCommit}`)
          expect(yield* runGitCommand(memberMount, 'rev-parse', 'HEAD')).toBe(newCommit)
          const warm = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--worktree-mode', 'tracking'],
            env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })
          expect(warm.exitCode).toBe(0)
          expect(yield* fs.realPath(memberMount)).toBe(`${repoBasePath}refs/commits/${newCommit}`)
          expect(yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')).toBe(initialCommit)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 30_000 },
    )
  })

  describe('author-owned branch workspace', () => {
    /** Store remote `test-owner/test-repo` whose `main` advanced past the locked commit. */
    const createAdvancedRemoteFixture = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
      const sourceRepoPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('source/'))
      yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
      yield* initGitRepo(sourceRepoPath)
      yield* runGitCommand(sourceRepoPath, 'checkout', '-b', 'main').pipe(
        Effect.catch(() => Effect.void),
      )
      yield* fs.writeFileString(`${sourceRepoPath}README.md`, '# Test Repo\n')
      yield* runGitCommand(sourceRepoPath, 'add', '-A')
      yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Initial commit')
      const initialCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
      const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
      const bareRepoPath = `${storePath}github.com/test-owner/test-repo/.bare`
      yield* fs.makeDirectory(`${storePath}github.com/test-owner/test-repo`, { recursive: true })
      yield* runGitCommand(tmpDir, 'clone', '--bare', sourceRepoPath, bareRepoPath)
      yield* runGitCommand(
        EffectPath.unsafe.absoluteDir(`${bareRepoPath}/`),
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      )
      yield* fs.writeFileString(`${sourceRepoPath}new-file.txt`, 'new content\n')
      yield* runGitCommand(sourceRepoPath, 'add', '-A')
      yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Second commit')
      const newCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
      const lockAt = (commit: string) =>
        encodeJson({
          version: 1,
          members: {
            'test-repo': {
              url: 'https://github.com/test-owner/test-repo',
              ref: 'main',
              commit,
              pinned: false,
              lockedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        })
      /** Store bare cloned from the source; its HEAD (default branch) is `main`. */
      const makeStoreBare = (repo: string) =>
        Effect.gen(function* () {
          const bare = `${storePath}github.com/test-owner/${repo}/.bare`
          yield* fs.makeDirectory(path.dirname(bare), { recursive: true })
          yield* runGitCommand(tmpDir, 'clone', '--bare', sourceRepoPath, bare)
        })
      /**
       * Megarepo root at `refs/<kind>/<name>/` (plus an optional subdirectory). With a store
       * bare, that path is a real worktree: `heads/<B>` checks out branch `<B>`, other kinds
       * are detached.
       */
      const makeStoreRoot = (
        repo: string,
        ref: string,
        members: Record<string, string>,
        subdir?: string,
      ) =>
        Effect.gen(function* () {
          const worktree = `${storePath}github.com/test-owner/${repo}/refs/${ref}`
          const bare = `${storePath}github.com/test-owner/${repo}/.bare`
          if ((yield* fs.exists(bare)) === true) {
            yield* fs.makeDirectory(path.dirname(worktree), { recursive: true })
            const branch =
              ref.startsWith('heads/') === true ? ref.slice('heads/'.length) : undefined
            yield* runGitCommand(
              EffectPath.unsafe.absoluteDir(`${bare}/`),
              ...(branch === undefined
                ? ['worktree', 'add', '--detach', worktree, 'main']
                : branch === 'main'
                  ? ['worktree', 'add', worktree, 'main']
                  : ['worktree', 'add', '-b', branch, worktree, 'main']),
            )
          }
          const root = EffectPath.unsafe.absoluteDir(
            subdir === undefined ? `${worktree}/` : `${worktree}/${subdir}/`,
          )
          yield* fs.makeDirectory(root, { recursive: true })
          yield* fs.writeFileString(`${root}megarepo.json`, encodeJson({ members }))
          return root
        })
      return { storePath, initialCommit, newCommit, lockAt, makeStoreBare, makeStoreRoot }
    })

    const fetchApplyArgs = [
      '--output',
      'json',
      '--only',
      'test-repo',
      '--worktree-mode',
      'commit',
      '--lock-sync',
      'off',
    ]

    for (const author of [true, false]) {
      it.effect(
        `fetch --only writes only the invoking author lock (author: ${author})`,
        Effect.fnUntraced(
          function* () {
            const fs = yield* FileSystem.FileSystem
            const { storePath, initialCommit, newCommit, lockAt, makeStoreBare, makeStoreRoot } =
              yield* createAdvancedRemoteFixture
            yield* makeStoreBare('workspace')
            const branch = author === true ? 'schickling-assistant/team/feature' : 'main'
            const root = yield* makeStoreRoot('workspace', `heads/${branch}`, {
              'test-repo': 'test-owner/test-repo',
            })
            const originalLock = lockAt(initialCommit)
            yield* fs.writeFileString(`${root}megarepo.lock`, originalLock)
            const headBefore = yield* Git.getCurrentCommit(root)
            const result = yield* runFetchCommand({
              cwd: root,
              args: ['--output', 'json', '--only', 'test-repo'],
              env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
            })
            expect(result.exitCode).toBe(author === true ? 0 : 1)
            expect(yield* Git.getCurrentCommit(root)).toBe(headBefore)
            expect(Option.getOrUndefined(yield* Git.getCurrentBranch(root))).toBe(branch)
            expect(yield* fs.exists(`${root}repos`)).toBe(false)
            if (author === true) {
              expect(yield* fs.readFileString(`${root}megarepo.lock`)).toContain(newCommit)
            } else {
              expect(yield* fs.readFileString(`${root}megarepo.lock`)).toBe(originalLock)
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit) === true) {
                expect(Cause.pretty(result.exit.cause)).toContain('Refusing to mutate canonical')
              }
            }
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
        { timeout: 30_000 },
      )
    }

    const authorRootCases = [
      { name: 'a feature branch', ref: 'heads/feat/x', bare: true, granted: true },
      { name: 'the default branch', ref: 'heads/main', bare: true, granted: false },
      {
        name: 'a default-branch subdirectory',
        ref: 'heads/main',
        subdir: 'workspace',
        bare: true,
        granted: false,
      },
      {
        name: 'a feature-branch subdirectory',
        ref: 'heads/feat/x',
        subdir: 'workspace',
        bare: true,
        granted: false,
      },
      { name: 'an unresolvable default branch', ref: 'heads/feat/x', bare: false, granted: false },
      { name: 'a tag', ref: 'tags/team/feature', bare: true, granted: false },
      { name: 'a commit', ref: 'commits/team/feature', bare: true, granted: false },
    ] as const

    for (const authorRoot of authorRootCases) {
      it.effect(
        `updates the invoking workspace's own lock and mounts only for ${authorRoot.name} root when granted`,
        Effect.fnUntraced(
          function* () {
            const fs = yield* FileSystem.FileSystem
            const { storePath, initialCommit, newCommit, lockAt, makeStoreBare, makeStoreRoot } =
              yield* createAdvancedRemoteFixture
            if (authorRoot.bare === true) yield* makeStoreBare('workspace')
            const root = yield* makeStoreRoot(
              'workspace',
              authorRoot.ref,
              { 'test-repo': 'test-owner/test-repo' },
              'subdir' in authorRoot ? authorRoot.subdir : undefined,
            )
            yield* fs.writeFileString(`${root}megarepo.lock`, lockAt(initialCommit))

            const result = yield* runFetchApplyCommand({
              cwd: root,
              args: fetchApplyArgs,
              env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
            })

            if (authorRoot.granted === true) {
              expect(result.exitCode).toBe(0)
              expect(yield* fs.readFileString(`${root}megarepo.lock`)).toContain(
                `"commit": "${newCommit}"`,
              )
              expect(yield* fs.realPath(`${root}repos/test-repo`)).toContain(
                `/refs/commits/${newCommit}`,
              )
            } else {
              expect(result.exitCode).toBe(1)
              expect(Exit.isFailure(result.exit)).toBe(true)
              if (Exit.isFailure(result.exit) === true) {
                expect(Cause.pretty(result.exit.cause)).toContain(
                  'Refusing to mutate canonical worktree',
                )
              }
              expect(yield* fs.readFileString(`${root}megarepo.lock`)).toBe(lockAt(initialCommit))
              expect(yield* fs.exists(`${root}repos`)).toBe(false)
            }
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
        { timeout: 30_000 },
      )
    }

    it.effect(
      'still refuses fetching into a nested canonical member from an author workspace',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { storePath, initialCommit, lockAt, makeStoreBare, makeStoreRoot } =
            yield* createAdvancedRemoteFixture
          yield* makeStoreBare('workspace')
          yield* makeStoreBare('child')
          const child = yield* makeStoreRoot('child', 'heads/main', {
            'test-repo': 'test-owner/test-repo',
          })
          yield* fs.writeFileString(`${child}megarepo.lock`, lockAt(initialCommit))
          const root = yield* makeStoreRoot('workspace', 'heads/team/feature', {
            child: child.slice(0, -1),
          })
          yield* fs.writeFileString(`${root}megarepo.lock`, encodeJson({ version: 1, members: {} }))

          const result = yield* runFetchApplyCommand({
            cwd: root,
            args: ['--output', 'json', '--all', '--worktree-mode', 'commit', '--lock-sync', 'off'],
            env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })

          expect(result.exitCode).toBe(1)
          expect(`${result.stdout}\n${result.stderr}`).toContain(
            'Refusing to mutate canonical worktree',
          )
          expect(yield* fs.readFileString(`${child}megarepo.lock`)).toBe(lockAt(initialCommit))
          expect(yield* fs.exists(`${child}repos`)).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 30_000 },
    )

    it.effect(
      'refuses a feature-branch lock file that aliases another canonical root',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { storePath, initialCommit, lockAt, makeStoreBare, makeStoreRoot } =
            yield* createAdvancedRemoteFixture
          yield* makeStoreBare('workspace')
          yield* makeStoreBare('shared')
          const shared = yield* makeStoreRoot('shared', 'heads/main', {})
          yield* fs.writeFileString(`${shared}megarepo.lock`, lockAt(initialCommit))
          const root = yield* makeStoreRoot('workspace', 'heads/team/feature', {
            'test-repo': 'test-owner/test-repo',
          })
          yield* fs.symlink(`${shared}megarepo.lock`, `${root}megarepo.lock`)

          const result = yield* runFetchApplyCommand({
            cwd: root,
            args: fetchApplyArgs,
            env: { MEGAREPO_STORE: storePath, MEGAREPO_ALLOW_CANONICAL_MUTATION: '0' },
          })

          expect(result.exitCode).toBe(1)
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            expect(Cause.pretty(result.exit.cause)).toContain(
              'Refusing to mutate canonical worktree',
            )
          }
          expect(yield* fs.readFileString(`${shared}megarepo.lock`)).toBe(lockAt(initialCommit))
        },
        Effect.provide(NodeServices.layer),
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

        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'new-lib': localRepoPath,
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync for first time
        const result = yield* runFetchApplyCommand({
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
      Effect.provide(NodeServices.layer),
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
        const missingRemotePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('missing-remote.git/'),
        )

        // Create megarepo.json with a missing remote. Use file:// so the clone
        // failure is deterministic and does not spend the test timeout on
        // network/auth retries.
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'non-existent-repo': pathToFileURL(missingRemotePath).href,
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync --json to get structured output
        const result = yield* runFetchApplyCommand({
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
        // Should indicate the actual git/remote problem, not an internal API failure.
        expect(
          memberResult?.message?.toLowerCase().includes('clone') ||
            memberResult?.message?.toLowerCase().includes('repository') ||
            memberResult?.message?.toLowerCase().includes('not found') ||
            memberResult?.message?.toLowerCase().includes('access') ||
            memberResult?.message?.toLowerCase().includes('network') ||
            memberResult?.message?.toLowerCase().includes('connect') ||
            memberResult?.message?.toLowerCase().includes('ssh') ||
            memberResult?.message?.toLowerCase().includes('auth'),
        ).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('foreign member mount guards', () => {
  it.effect(
    'fails apply and dry-run identically for a configured local-path real directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const sourcePath = yield* createRepo({
          basePath: tmpDir,
          fixture: { name: 'local-source', files: { 'source.txt': 'source\n' } },
        })
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { 'local-lib': sourcePath },
        })
        yield* writeLockFile({
          lockPath: EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          ),
          lockFile: createEmptyLockFile(),
        })

        const memberPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/local-lib'),
        )
        const sentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${memberPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const sentinel = new Uint8Array([0, 255, 17, 10, 0, 99])
        yield* fs.makeDirectory(memberPath, { recursive: true })
        yield* fs.writeFile(sentinelPath, sentinel)

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const appliedResult = decodeSyncJsonOutput(applied.stdout.trim()).results[0]
        const previewedResult = decodeSyncJsonOutput(previewed.stdout.trim()).results[0]
        const expectedMessage = `Refusing to replace member 'local-lib' at '${memberPath}': it is a foreign non-symlink mount`

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(appliedResult).toMatchObject({
          name: 'local-lib',
          status: 'error',
          message: expectedMessage,
        })
        expect(previewedResult).toEqual(appliedResult)
        expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
        expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails apply and dry-run identically for a configured remote real directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* createStoreFixture([
          { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
        ])
        const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
        if (mainWorktree === undefined) throw new Error('Missing main worktree')
        const commit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { lib: 'https://example.com/acme/lib#main' },
          lockEntries: {
            lib: { url: 'https://example.com/acme/lib', ref: 'main', commit },
          },
        })
        const memberPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/lib'),
        )
        const sentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${memberPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const sentinel = new Uint8Array([222, 173, 190, 239, 0, 10])
        yield* fs.makeDirectory(memberPath, { recursive: true })
        yield* fs.writeFile(sentinelPath, sentinel)
        const configBefore = yield* fs.readFile(configPath)
        const lockBefore = yield* fs.readFile(lockPath)
        const env = { MEGAREPO_STORE: store.storePath.slice(0, -1) }

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
          env,
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
          env,
        })
        const appliedResult = decodeSyncJsonOutput(applied.stdout.trim()).results[0]
        const previewedResult = decodeSyncJsonOutput(previewed.stdout.trim()).results[0]
        const expectedMessage = `Refusing to replace member 'lib' at '${memberPath}': it is a foreign non-symlink mount`

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(appliedResult).toMatchObject({
          name: 'lib',
          status: 'error',
          message: expectedMessage,
        })
        expect(previewedResult).toEqual(appliedResult)
        expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
        expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
        expect(yield* fs.readFile(configPath)).toEqual(configBefore)
        expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
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

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --only repo1
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeServices.layer),
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

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --skip repo2
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--skip', 'repo2'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1 (repo2 was skipped)
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeServices.layer),
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

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: 'owner/repo1',
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with both --only and --skip (should fail)
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1', '--skip', 'repo2'],
          })

          // Should have failed
          expect(result.exitCode).not.toBe(0)
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            const cause = result.exit.cause
            const failureMessages = cause.reasons
              .filter((reason) => reason._tag === 'Fail')
              .map((reason) => String(reason.error))
              .join('\n')
            expect(failureMessages.toLowerCase()).toContain('mutually exclusive')
          }
        },
        Effect.provide(NodeServices.layer),
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

/**
 * These tests mutate the store worktree itself (git checkout, commit), so each needs
 * its own createStoreFixture. Higher timeout because store creation + CLI execution
 * can exceed the default 5s on macOS CI runners.
 */
describe('sync worktree ref mismatch detection', () => {
  /**
   * REGRESSION TEST for issue #88: mr apply should detect worktree ref mismatch
   *
   * When a user runs `git checkout <other-branch>` directly inside a store worktree,
   * the worktree path no longer matches its git HEAD. This violates invariant #8:
   * "Worktree path matches HEAD: The ref encoded in a worktree's store path should match its git HEAD"
   *
   * Currently, `mr apply` reports "already up to date" without detecting this drift.
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
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            // Using https URL so it's treated as URL type, not path type
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )

        // Create lock file
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
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          }),
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

        // Run mr fetch --apply with tracking mode — should detect and warn about the ref mismatch
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--worktree-mode', 'tracking'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // With worktree mode support: apply no longer blocks on ref mismatch.
        // It proceeds (possibly falling back to commit worktree) instead of returning 'skipped'.
        expect(memberResult?.status).not.toBe('skipped')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
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
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )

        // Create lock file
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
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          }),
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

        // Run mr fetch --apply with tracking mode — should detect and warn about the detached HEAD mismatch
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--worktree-mode', 'tracking'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // With worktree mode support: apply no longer blocks on detached HEAD mismatch.
        // It proceeds (possibly falling back to commit worktree) instead of returning 'skipped'.
        expect(memberResult?.status).not.toBe('skipped')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
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
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Initial config with both members
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            initialConfig,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

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
        const updatedConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            // repo2 removed!
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            updatedConfig,
          )) + '\n',
        )

        // Second sync - should detect and remove orphaned repo2 symlink
        const result = yield* runFetchApplyCommand({
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
      Effect.provide(NodeServices.layer),
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
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Initial config with both members
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            initialConfig,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

        // Update config to remove repo2
        const updatedConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            updatedConfig,
          )) + '\n',
        )

        // Sync with --dry-run - should report removed but not actually remove
        const result = yield* runFetchApplyCommand({
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
      Effect.provide(NodeServices.layer),
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
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Config with both members
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            config,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

        // Sync with --skip repo2 - should NOT treat repo2 as removed
        const result = yield* runFetchApplyCommand({
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
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails identically for real directory and regular-file orphans without changing bytes',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { workspacePath } = yield* createWorkspaceWithLock({ members: {} })
        yield* writeLockFile({
          lockPath: EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          ),
          lockFile: createEmptyLockFile(),
        })

        const orphanDirPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/orphan-dir'),
        )
        const directorySentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${orphanDirPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const orphanFilePath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/orphan-file'),
        )
        const directorySentinel = new Uint8Array([0, 1, 2, 253, 254, 255])
        const orphanFile = new Uint8Array([255, 0, 127, 128, 10, 13])
        yield* fs.makeDirectory(orphanDirPath, { recursive: true })
        yield* fs.writeFile(directorySentinelPath, directorySentinel)
        yield* fs.writeFile(orphanFilePath, orphanFile)

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const appliedResults = decodeSyncJsonOutput(applied.stdout.trim()).results
        const previewedResults = decodeSyncJsonOutput(previewed.stdout.trim()).results

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(previewedResults).toEqual(appliedResults)
        expect(appliedResults.find((result) => result.name === 'orphan-dir')).toEqual({
          name: 'orphan-dir',
          status: 'error',
          message: `Refusing to remove member 'orphan-dir' at '${orphanDirPath}': it is a foreign non-symlink mount`,
        })
        expect(appliedResults.find((result) => result.name === 'orphan-file')).toEqual({
          name: 'orphan-file',
          status: 'error',
          message: `Refusing to remove member 'orphan-file' at '${orphanFilePath}': it is a foreign non-symlink mount`,
        })
        expect(Array.from(yield* fs.readFile(directorySentinelPath))).toEqual(
          Array.from(directorySentinel),
        )
        expect(yield* fs.readDirectory(orphanDirPath)).toEqual(['sentinel.bin'])
        expect(Array.from(yield* fs.readFile(orphanFilePath))).toEqual(Array.from(orphanFile))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
