import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Fiber, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { findMegarepoRoot } from '../cli/context.ts'
import * as Git from './git.ts'
import { OWNED_WORKTREE_ROOT_MANIFEST } from './owned-worktree-acquisition-schema.ts'
import {
  acquireOwnedWorktree,
  ownedWorktreeAcquisitionJournalPath,
  planOwnedWorktreeAcquisition,
  recoverOwnedWorktreeAcquisition,
  recoverStaleOwnedWorktreeAcquisitionLock,
  teardownOwnedWorkspace,
  type OwnedWorkspaceGenerationContext,
  type OwnedWorktreeAcquisitionBoundary,
} from './owned-worktree-acquisition.ts'

class TestWorkspaceIoError extends Schema.TaggedError<TestWorkspaceIoError>()(
  'TestWorkspaceIoError',
  { cause: Schema.Defect() },
) {}

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const
const previousAgentPolicyBypass = process.env['AGENT_POLICY_BYPASS']
beforeAll(() => {
  process.env['AGENT_POLICY_BYPASS'] = '1'
})
afterAll(() => {
  if (previousAgentPolicyBypass === undefined) delete process.env['AGENT_POLICY_BYPASS']
  else process.env['AGENT_POLICY_BYPASS'] = previousAgentPolicyBypass
})

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Git.runCommand({ cwd, args: [...GIT_USER, ...args] })

const makeFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* fs.makeTempDirectoryScoped()
  const source = NodePath.join(tmp, 'source')
  const bareRepo = NodePath.join(tmp, 'repo.git')
  const workspaceRoot = NodePath.join(tmp, 'workspace')
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.kdl')),
    'members {}\n',
  )
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, '.gitignore')),
    'ignored.txt\n',
  )
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'tracked.txt')),
    'base\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(tmp, 'clone', '--bare', source, bareRepo)
  yield* git(bareRepo, 'worktree', 'add', workspaceRoot, 'main')
  return {
    tmp,
    source,
    bareRepo,
    workspaceRoot,
    ownedWorktree: NodePath.join(workspaceRoot, 'repos', 'owner'),
  }
})

const generateWorkspace = (context: OwnedWorkspaceGenerationContext) =>
  Effect.tryPromise({
    try: async () => {
      await writeFile(NodePath.join(context.workspaceRoot, '.buckroot'), '')
      await writeFile(NodePath.join(context.workspaceRoot, 'generated.txt'), 'generated\n')
    },
    catch: (cause) => new TestWorkspaceIoError({ cause }),
  })

const cleanupWorkspace = (context: OwnedWorkspaceGenerationContext) =>
  Effect.tryPromise({
    try: async () => {
      await rm(NodePath.join(context.workspaceRoot, '.buckroot'))
      await rm(NodePath.join(context.workspaceRoot, 'generated.txt'))
    },
    catch: (cause) => new TestWorkspaceIoError({ cause }),
  })

const readText = (path: string) => Effect.promise(() => readFile(path, 'utf8'))
const regularFileExists = (path: string) =>
  Effect.promise(() =>
    readFile(path).then(
      () => true,
      () => false,
    ),
  )

const status = (path: string) =>
  Git.runCommand({
    cwd: path,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
  })

const installOrphanAcquisitionLock = ({
  fixture,
  token,
  pid,
  malformed = false,
}: {
  fixture: Effect.Success<ReturnType<typeof makeFixture>>
  token: string
  pid: number
  malformed?: boolean
}) =>
  Effect.tryPromise({
    try: async () => {
      const lockPath = NodePath.join(
        fixture.tmp,
        `.${NodePath.basename(fixture.workspaceRoot)}.owned-worktree-acquisition.lock`,
      )
      const ownerPath = `${lockPath}.owner-${token}`
      const bytes =
        malformed === true
          ? '{ malformed owner\n'
          : `{"nonce":"${token}","pid":${pid},"version":1}\n`
      await writeFile(ownerPath, bytes, { flag: 'wx', mode: 0o600 })
      await link(ownerPath, lockPath)
      return { lockPath, ownerPath }
    },
    catch: (cause) => new TestWorkspaceIoError({ cause }),
  })

const acquire = (
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  options: {
    readonly runtime?: Parameters<typeof acquireOwnedWorktree>[0]['runtime']
    readonly generate?: typeof generateWorkspace
    readonly callerCwd?: string
    readonly ownedMember?: string
  } = {},
) =>
  acquireOwnedWorktree({
    bareRepo: fixture.bareRepo,
    workspaceRoot: fixture.workspaceRoot,
    ownedMember: options.ownedMember ?? 'owner',
    branch: 'main',
    generate: options.generate ?? generateWorkspace,
    callerCwd: options.callerCwd ?? fixture.tmp,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  })

const planAcquisition = (fixture: Effect.Success<ReturnType<typeof makeFixture>>) =>
  planOwnedWorktreeAcquisition({
    bareRepo: fixture.bareRepo,
    workspaceRoot: fixture.workspaceRoot,
    ownedMember: 'owner',
    branch: 'main',
    callerCwd: fixture.tmp,
  })

const snapshotPlanningState = (fixture: Effect.Success<ReturnType<typeof makeFixture>>) =>
  Effect.gen(function* () {
    const base = NodePath.basename(fixture.workspaceRoot)
    const tempPath = NodePath.join(fixture.tmp, `.${base}.owned-worktree-acquisition-temp`)
    const journalPath = ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot)
    const lockPath = NodePath.join(fixture.tmp, `.${base}.owned-worktree-acquisition.lock`)
    const rootStagePath = NodePath.join(fixture.tmp, `.${base}.owned-worktree-root-stage`)
    const relevantPaths = [
      fixture.workspaceRoot,
      tempPath,
      fixture.ownedWorktree,
      journalPath,
      lockPath,
      rootStagePath,
      NodePath.join(fixture.workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
      NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'),
      NodePath.join(fixture.ownedWorktree, 'megarepo.kdl'),
    ]
    const observations = yield* Effect.promise(async () =>
      Promise.all(
        relevantPaths.map(async (path) => {
          try {
            const info = await lstat(path)
            if (info.isSymbolicLink() === true) {
              return { path, kind: 'Symlink', target: await readlink(path) } as const
            }
            if (info.isDirectory() === true) {
              return { path, kind: 'Directory', entries: (await readdir(path)).toSorted() } as const
            }
            return { path, kind: 'File', bytes: await readFile(path, 'utf8') } as const
          } catch (cause) {
            const code =
              cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
                ? cause.code
                : undefined
            if (code === 'ENOENT') return { path, kind: 'Missing' } as const
            throw cause
          }
        }),
      ),
    )
    const worktreeStatus: Array<{ readonly path: string; readonly porcelain: string }> = []
    for (const path of [fixture.workspaceRoot, tempPath, fixture.ownedWorktree]) {
      const dotGit = yield* Effect.promise(() =>
        lstat(NodePath.join(path, '.git')).then(
          () => true,
          () => false,
        ),
      )
      if (dotGit === true) worktreeStatus.push({ path, porcelain: yield* status(path) })
    }
    return {
      parentEntries: (yield* Effect.promise(() => readdir(fixture.tmp))).toSorted(),
      worktreeListPorcelain: yield* git(fixture.bareRepo, 'worktree', 'list', '--porcelain'),
      worktreeStatus,
      observations,
    }
  })

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe('owned worktree acquisition', () => {
  it.effect(
    'installs a clean worktree, publishes a live relative config authority, discovers the outer root, and is idempotent',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        let generations = 0
        const generate = (context: OwnedWorkspaceGenerationContext) =>
          generateWorkspace(context).pipe(Effect.tap(() => Effect.sync(() => generations++)))
        const result = yield* acquire(fixture, { generate })
        expect(result).toEqual({
          _tag: 'Acquired',
          workspaceRoot: `${fixture.workspaceRoot}/`,
          ownedWorktree: `${fixture.ownedWorktree}/`,
          defaultCwd: `${fixture.ownedWorktree}/`,
          configPath: NodePath.join(fixture.ownedWorktree, 'megarepo.kdl'),
          configName: 'megarepo.kdl',
        })
        expect(
          yield* Effect.promise(() =>
            readlink(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl')),
          ),
        ).toBe('repos/owner/megarepo.kdl')
        const discovered = yield* findMegarepoRoot(
          EffectPath.unsafe.absoluteDir(`${fixture.ownedWorktree}/`),
        )
        expect(Option.getOrThrow(discovered)).toBe(`${fixture.workspaceRoot}/`)
        yield* Effect.promise(() =>
          writeFile(
            NodePath.join(fixture.ownedWorktree, 'megarepo.kdl'),
            'members { updated "true" }\n',
          ),
        )
        expect(yield* readText(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'))).toContain(
          'updated',
        )

        const second = yield* acquire(fixture, { generate })
        expect(second).toEqual(result)
        expect(generations).toBe(1)
        expect(
          yield* readText(NodePath.join(fixture.workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST)),
        ).toMatch(/^\{"adminDir":/u)
      }).pipe(withNode),
  )

  it.effect(
    'preserves staged, dirty, untracked, and ignored bytes and restores exact Git registration on teardown',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.workspaceRoot, 'staged.txt'), 'staged\n'),
        )
        yield* git(fixture.workspaceRoot, 'add', 'staged.txt')
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.workspaceRoot, 'tracked.txt'), 'dirty\n'),
        )
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.workspaceRoot, 'untracked.txt'), 'untracked\n'),
        )
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.workspaceRoot, 'ignored.txt'), 'ignored\n'),
        )
        const beforeStatus = yield* status(fixture.workspaceRoot)
        const beforeRegistration = yield* git(fixture.bareRepo, 'worktree', 'list', '--porcelain')

        yield* acquire(fixture)
        expect(yield* status(fixture.ownedWorktree)).toBe(beforeStatus)
        expect(yield* readText(NodePath.join(fixture.ownedWorktree, 'staged.txt'))).toBe('staged\n')
        expect(yield* readText(NodePath.join(fixture.ownedWorktree, 'tracked.txt'))).toBe('dirty\n')
        expect(yield* readText(NodePath.join(fixture.ownedWorktree, 'untracked.txt'))).toBe(
          'untracked\n',
        )
        expect(yield* readText(NodePath.join(fixture.ownedWorktree, 'ignored.txt'))).toBe(
          'ignored\n',
        )

        const tornDown = yield* teardownOwnedWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          cleanup: cleanupWorkspace,
          callerCwd: fixture.tmp,
        })
        expect(tornDown.defaultCwd).toBe(fixture.workspaceRoot)
        expect(yield* status(fixture.workspaceRoot)).toBe(beforeStatus)
        expect(yield* git(fixture.bareRepo, 'worktree', 'list', '--porcelain')).toBe(
          beforeRegistration,
        )
      }).pipe(withNode),
  )

  it.effect('refuses another attachment of the owned branch', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const second = NodePath.join(fixture.tmp, 'second')
      yield* git(fixture.bareRepo, 'worktree', 'add', '--force', second, 'main')
      const failure = yield* acquire(fixture).pipe(Effect.flip)
      expect(failure.reason).toBe('PreflightRefused')
      expect(yield* readText(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'))).toBe(
        'members {}\n',
      )
    }).pipe(withNode),
  )

  it.effect('refuses a caller cwd at or below the moving worktree', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const failure = yield* acquire(fixture, {
        callerCwd: NodePath.join(fixture.workspaceRoot, 'nested'),
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('PreflightRefused')
      expect(yield* git(fixture.workspaceRoot, 'rev-parse', '--show-toplevel')).toBe(
        fixture.workspaceRoot,
      )
    }).pipe(withNode),
  )

  it.effect('refuses invalid owned names and temporary-path collisions before mutation', () =>
    Effect.gen(function* () {
      const invalid = yield* makeFixture()
      const invalidFailure = yield* acquire(invalid, { ownedMember: '../owner' }).pipe(Effect.flip)
      expect(invalidFailure.reason).toBe('InvalidRequest')

      const collision = yield* makeFixture()
      const temporary = NodePath.join(
        collision.tmp,
        `.${NodePath.basename(collision.workspaceRoot)}.owned-worktree-acquisition-temp`,
      )
      yield* Effect.promise(() => mkdir(temporary))
      const collisionFailure = yield* acquire(collision).pipe(Effect.flip)
      expect(collisionFailure.reason).toBe('Collision')
      expect(collisionFailure.path).toBe(temporary)

      const destinationCollision = yield* makeFixture()
      yield* Effect.promise(() => mkdir(destinationCollision.ownedWorktree, { recursive: true }))
      const destinationFailure = yield* acquire(destinationCollision).pipe(Effect.flip)
      expect(destinationFailure.reason).toBe('Collision')
      expect(destinationFailure.path).toBe(destinationCollision.ownedWorktree)
    }).pipe(withNode),
  )

  it.effect('refuses nested registered worktrees', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* git(fixture.bareRepo, 'branch', 'nested-branch', 'main')
      const nested = NodePath.join(fixture.workspaceRoot, 'nested-worktree')
      yield* git(fixture.bareRepo, 'worktree', 'add', nested, 'nested-branch')
      const failure = yield* acquire(fixture).pipe(Effect.flip)
      expect(failure.reason).toBe('PreflightRefused')
      expect(failure.message).toContain('nested registered worktree')
    }).pipe(withNode),
  )

  it.effect('refuses worktrees containing a submodule before writing a journal', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const submodule = NodePath.join(fixture.tmp, 'submodule')
      yield* Effect.promise(() => mkdir(submodule))
      yield* git(submodule, 'init', '-b', 'main')
      yield* Effect.promise(() => writeFile(NodePath.join(submodule, 'file.txt'), 'submodule\n'))
      yield* git(submodule, 'add', '-A')
      yield* git(submodule, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'submodule')
      yield* git(
        fixture.workspaceRoot,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        submodule,
        'sub',
      )
      const failure = yield* acquire(fixture).pipe(Effect.flip)
      expect(failure.reason).toBe('PreflightRefused')
      expect(failure.message).toContain('submodules')
      expect(
        yield* Effect.promise(() =>
          readFile(ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot), 'utf8').then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }).pipe(withNode),
  )

  it.effect(
    'excludes a synchronized concurrent acquisition before it can replace the journal',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        let signalEntered: () => void = () => undefined
        let releaseFirst: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        const blockingGenerate = (context: OwnedWorkspaceGenerationContext) =>
          Effect.promise(async () => {
            signalEntered()
            await gate
          }).pipe(Effect.andThen(generateWorkspace(context)))
        const first = yield* Effect.forkChild(acquire(fixture, { generate: blockingGenerate }))
        yield* Effect.promise(() => entered)
        const journalPath = ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot)
        const winnerJournal = yield* readText(journalPath)
        const second = yield* acquire(fixture).pipe(Effect.result)
        expect(second._tag).toBe('Failure')
        if (second._tag === 'Failure') expect(second.failure.reason).toBe('AcquisitionLocked')
        expect(yield* readText(journalPath)).toBe(winnerJournal)
        expect(yield* git(fixture.ownedWorktree, 'rev-parse', '--show-toplevel')).toBe(
          fixture.ownedWorktree,
        )
        releaseFirst()
        const completed = yield* Fiber.join(first)
        expect(completed.ownedWorktree).toBe(`${fixture.ownedWorktree}/`)
        const lockPath = NodePath.join(
          fixture.tmp,
          `.${NodePath.basename(fixture.workspaceRoot)}.owned-worktree-acquisition.lock`,
        )
        expect(
          yield* Effect.promise(() =>
            readFile(lockPath, 'utf8').then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(withNode),
  )

  it.effect('recovers a crash-orphaned lock for an exact definitely-dead owner and proceeds', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const token = 'd'.repeat(32)
      const orphan = yield* installOrphanAcquisitionLock({
        fixture,
        token,
        pid: 999_999,
      })
      let parentSynced = false
      yield* recoverStaleOwnedWorktreeAcquisitionLock({
        workspaceRoot: fixture.workspaceRoot,
        token,
        runtime: {
          processAlive: async () => 'dead',
          directoryFsync: async ({ sync }) => {
            await sync()
            parentSynced = true
          },
        },
      })
      expect(parentSynced).toBe(true)
      expect(yield* regularFileExists(orphan.lockPath)).toBe(false)
      expect(yield* regularFileExists(orphan.ownerPath)).toBe(false)
      const acquired = yield* acquire(fixture)
      expect(acquired.ownedWorktree).toBe(`${fixture.ownedWorktree}/`)
    }).pipe(withNode),
  )

  it.effect('refuses stale recovery for a live owner and prints its exact token instruction', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const token = 'a'.repeat(32)
      const orphan = yield* installOrphanAcquisitionLock({
        fixture,
        token,
        pid: process.pid,
      })
      const recoveryFailure = yield* recoverStaleOwnedWorktreeAcquisitionLock({
        workspaceRoot: fixture.workspaceRoot,
        token,
      }).pipe(Effect.flip)
      expect(recoveryFailure.reason).toBe('StaleLockRecoveryRefused')
      expect(recoveryFailure.message).toContain('is alive')
      expect(yield* regularFileExists(orphan.lockPath)).toBe(true)
      const unknownFailure = yield* recoverStaleOwnedWorktreeAcquisitionLock({
        workspaceRoot: fixture.workspaceRoot,
        token,
        runtime: { processAlive: async () => 'unknown' },
      }).pipe(Effect.flip)
      expect(unknownFailure.reason).toBe('StaleLockRecoveryRefused')
      expect(unknownFailure.message).toContain('is unknown')
      expect(yield* regularFileExists(orphan.lockPath)).toBe(true)

      const acquisitionFailure = yield* acquire(fixture).pipe(Effect.flip)
      expect(acquisitionFailure.reason).toBe('AcquisitionLocked')
      expect(acquisitionFailure.message).toContain(`token '${token}'`)
      expect(acquisitionFailure.message).toContain('recoverStaleOwnedWorktreeAcquisitionLock')
    }).pipe(withNode),
  )

  it.effect(
    'refuses a wrong stale-lock token without consulting liveness or deleting the owner',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const token = 'b'.repeat(32)
        const orphan = yield* installOrphanAcquisitionLock({
          fixture,
          token,
          pid: 999_998,
        })
        let livenessConsulted = false
        const failure = yield* recoverStaleOwnedWorktreeAcquisitionLock({
          workspaceRoot: fixture.workspaceRoot,
          token: 'c'.repeat(32),
          runtime: {
            processAlive: async () => {
              livenessConsulted = true
              return 'dead'
            },
          },
        }).pipe(Effect.flip)
        expect(failure.reason).toBe('StaleLockRecoveryRefused')
        expect(livenessConsulted).toBe(false)
        expect(yield* regularFileExists(orphan.lockPath)).toBe(true)
        expect(yield* regularFileExists(orphan.ownerPath)).toBe(true)
      }).pipe(withNode),
  )

  it.effect('refuses malformed owner bytes without exposing an unsafe recovery path', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const token = 'e'.repeat(32)
      const orphan = yield* installOrphanAcquisitionLock({
        fixture,
        token,
        pid: 999_997,
        malformed: true,
      })
      const recoveryFailure = yield* recoverStaleOwnedWorktreeAcquisitionLock({
        workspaceRoot: fixture.workspaceRoot,
        token,
        runtime: { processAlive: async () => 'dead' },
      }).pipe(Effect.flip)
      expect(recoveryFailure.reason).toBe('StaleLockRecoveryRefused')
      expect(yield* regularFileExists(orphan.lockPath)).toBe(true)
      expect(yield* regularFileExists(orphan.ownerPath)).toBe(true)

      const acquisitionFailure = yield* acquire(fixture).pipe(Effect.flip)
      expect(acquisitionFailure.reason).toBe('AcquisitionLocked')
      expect(acquisitionFailure.message).toContain('owner/token')
      expect(acquisitionFailure.message).toContain('unavailable')
    }).pipe(withNode),
  )

  it.effect('leaves no journal or mutation when interrupted after preflight', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const before = yield* git(fixture.bareRepo, 'worktree', 'list', '--porcelain')
      const result = yield* acquire(fixture, {
        runtime: {
          afterBoundary: async (boundary) => {
            if (boundary === 'PreflightComplete') throw new Error('crash')
          },
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      expect(yield* git(fixture.bareRepo, 'worktree', 'list', '--porcelain')).toBe(before)
      expect(
        yield* Effect.promise(() =>
          readFile(ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot), 'utf8').then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }).pipe(withNode),
  )

  it.effect('writes canonical durable journal bytes', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const result = yield* acquire(fixture, {
        runtime: {
          afterBoundary: async (boundary) => {
            if (boundary === 'JournalPrepared') throw new Error('crash')
          },
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      const bytes = yield* readText(ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot))
      expect(bytes.endsWith('\n')).toBe(true)
      expect(bytes.slice(0, -1)).not.toContain('\n')
      const orderedKeys = [
        'adminDir',
        'bareRepo',
        'branchRef',
        'head',
        'ownedMember',
        'state',
        'statusPorcelainBase64',
        'tempPath',
        'version',
        'workspaceRoot',
      ] as const
      let previousIndex = -1
      for (const key of orderedKeys) {
        const index = bytes.indexOf(`"${key}":`)
        expect(index, key).toBeGreaterThan(previousIndex)
        previousIndex = index
      }
      const recovered = yield* recoverOwnedWorktreeAcquisition({
        workspaceRoot: fixture.workspaceRoot,
        generate: generateWorkspace,
      })
      expect(recovered._tag).toBe('RolledBack')
    }).pipe(withNode),
  )

  it.effect(
    'rolls back every pre-install interruption from observed paths rather than journal state',
    () =>
      Effect.gen(function* () {
        const boundaries: ReadonlyArray<OwnedWorktreeAcquisitionBoundary> = [
          'MovedToTemp',
          'MovedToTempJournaled',
          'RootCreated',
          'RootCreatedJournaled',
        ]
        for (const boundaryToFail of boundaries) {
          const fixture = yield* makeFixture()
          const before = yield* status(fixture.workspaceRoot)
          const result = yield* acquire(fixture, {
            runtime: {
              afterBoundary: async (boundary) => {
                if (boundary === boundaryToFail) throw new Error(`crash ${boundary}`)
              },
            },
          }).pipe(Effect.result)
          expect(result._tag, boundaryToFail).toBe('Failure')
          const recovered = yield* recoverOwnedWorktreeAcquisition({
            workspaceRoot: fixture.workspaceRoot,
            generate: generateWorkspace,
          })
          expect(recovered._tag, boundaryToFail).toBe('RolledBack')
          expect(yield* status(fixture.workspaceRoot)).toBe(before)
        }
      }).pipe(withNode),
  )

  it.effect(
    'rolls forward every post-install interruption and retries generation idempotently',
    () =>
      Effect.gen(function* () {
        const boundaries: ReadonlyArray<OwnedWorktreeAcquisitionBoundary> = [
          'Installed',
          'InstalledJournaled',
          'ConfigLinked',
          'Generated',
          'GeneratedJournaled',
          'CompleteJournaled',
        ]
        for (const boundaryToFail of boundaries) {
          const fixture = yield* makeFixture()
          let generationCount = 0
          const countedGenerate = (context: OwnedWorkspaceGenerationContext) =>
            generateWorkspace(context).pipe(Effect.tap(() => Effect.sync(() => generationCount++)))
          const result = yield* acquire(fixture, {
            generate: countedGenerate,
            runtime: {
              afterBoundary: async (boundary) => {
                if (boundary === boundaryToFail) throw new Error(`crash ${boundary}`)
              },
            },
          }).pipe(Effect.result)
          expect(result._tag, boundaryToFail).toBe('Failure')
          const recovered = yield* recoverOwnedWorktreeAcquisition({
            workspaceRoot: fixture.workspaceRoot,
            generate: countedGenerate,
          })
          expect(recovered._tag, boundaryToFail).toBe('RolledForward')
          expect(generationCount, boundaryToFail).toBe(boundaryToFail === 'Generated' ? 2 : 1)
          expect(yield* readText(NodePath.join(fixture.workspaceRoot, 'generated.txt'))).toBe(
            'generated\n',
          )
        }
      }).pipe(withNode),
  )

  it.effect('recognizes completion when failure happens after journal removal', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const result = yield* acquire(fixture, {
        runtime: {
          afterBoundary: async (boundary) => {
            if (boundary === 'JournalRemoved') throw new Error('caller did not observe completion')
          },
        },
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      const retried = yield* acquire(fixture)
      expect(retried.ownedWorktree).toBe(`${fixture.ownedWorktree}/`)
    }).pipe(withNode),
  )

  it.effect('refuses rollback when a foreign root entry appears', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* acquire(fixture, {
        runtime: {
          afterBoundary: async (boundary) => {
            if (boundary === 'RootCreated') throw new Error('crash')
          },
        },
      }).pipe(Effect.result)
      yield* Effect.promise(() =>
        writeFile(NodePath.join(fixture.workspaceRoot, 'foreign.txt'), 'foreign\n'),
      )
      const failure = yield* recoverOwnedWorktreeAcquisition({
        workspaceRoot: fixture.workspaceRoot,
        generate: generateWorkspace,
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('ForeignRootEntry')
      expect(yield* readText(NodePath.join(fixture.workspaceRoot, 'foreign.txt'))).toBe('foreign\n')
    }).pipe(withNode),
  )

  it.effect(
    'revalidates owned Git identity after cleanup and before the first teardown move',
    () =>
      Effect.gen(function* () {
        const mutations = [
          'tracked',
          'staged',
          'untracked',
          'head',
          'branch',
          'replacement',
        ] as const
        for (const mutation of mutations) {
          const fixture = yield* makeFixture()
          yield* acquire(fixture)
          const cleanup = (context: OwnedWorkspaceGenerationContext) =>
            Effect.gen(function* () {
              yield* cleanupWorkspace(context)
              if (mutation === 'tracked') {
                yield* Effect.promise(() =>
                  writeFile(
                    NodePath.join(context.ownedWorktree, 'tracked.txt'),
                    'cleanup mutation\n',
                  ),
                )
              } else if (mutation === 'staged') {
                yield* Effect.promise(() =>
                  writeFile(
                    NodePath.join(context.ownedWorktree, 'staged-by-cleanup.txt'),
                    'staged\n',
                  ),
                )
                yield* git(context.ownedWorktree, 'add', 'staged-by-cleanup.txt')
              } else if (mutation === 'untracked') {
                yield* Effect.promise(() =>
                  writeFile(
                    NodePath.join(context.ownedWorktree, 'untracked-by-cleanup.txt'),
                    'untracked\n',
                  ),
                )
              } else if (mutation === 'head') {
                yield* Effect.promise(() =>
                  writeFile(
                    NodePath.join(context.ownedWorktree, 'tracked.txt'),
                    'committed by cleanup\n',
                  ),
                )
                yield* git(context.ownedWorktree, 'add', 'tracked.txt')
                yield* git(
                  context.ownedWorktree,
                  'commit',
                  '--no-gpg-sign',
                  '--no-verify',
                  '-m',
                  'cleanup mutation',
                )
              } else if (mutation === 'branch') {
                yield* git(context.ownedWorktree, 'checkout', '--detach')
              } else {
                const replaced = NodePath.join(
                  NodePath.dirname(context.workspaceRoot.slice(0, -1)),
                  'owned-worktree-replaced',
                )
                yield* Effect.promise(async () => {
                  await rename(context.ownedWorktree, replaced)
                  await mkdir(context.ownedWorktree)
                  await writeFile(
                    NodePath.join(context.ownedWorktree, context.configName),
                    'members {}\n',
                  )
                })
              }
            })
          const failure = yield* teardownOwnedWorkspace({
            workspaceRoot: fixture.workspaceRoot,
            callerCwd: fixture.tmp,
            cleanup,
          }).pipe(Effect.flip)
          expect(['GitIdentityConflict', 'CommandFailure'].includes(failure.reason), mutation).toBe(
            true,
          )
          const temporary = NodePath.join(
            fixture.tmp,
            `.${NodePath.basename(fixture.workspaceRoot)}.owned-worktree-acquisition-temp`,
          )
          expect(
            yield* Effect.promise(() =>
              readFile(
                NodePath.join(fixture.workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
                'utf8',
              ).then(
                () => true,
                () => false,
              ),
            ),
            mutation,
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              readFile(temporary, 'utf8').then(
                () => true,
                () => false,
              ),
            ),
            mutation,
          ).toBe(false)
        }
      }).pipe(withNode),
    { timeout: 60_000 },
  )

  it.effect(
    'refuses teardown until generated cleanup removes every generated or foreign entry',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* acquire(fixture)
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.workspaceRoot, 'foreign.txt'), 'foreign\n'),
        )
        const failure = yield* teardownOwnedWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          callerCwd: fixture.tmp,
          cleanup: cleanupWorkspace,
        }).pipe(Effect.flip)
        expect(failure.reason).toBe('ForeignRootEntry')
        expect(yield* git(fixture.ownedWorktree, 'rev-parse', '--show-toplevel')).toBe(
          fixture.ownedWorktree,
        )
      }).pipe(withNode),
  )

  it.effect('plans legacy acquisition with exact ordered paths without mutation', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const before = yield* snapshotPlanningState(fixture)
      const plan = yield* planAcquisition(fixture)
      const after = yield* snapshotPlanningState(fixture)
      expect(after).toEqual(before)
      expect(plan._tag).toBe('Acquire')
      if (plan._tag !== 'Acquire') return
      const base = NodePath.basename(fixture.workspaceRoot)
      expect(plan).toMatchObject({
        workspaceRoot: fixture.workspaceRoot,
        ownedWorktree: fixture.ownedWorktree,
        tempPath: NodePath.join(fixture.tmp, `.${base}.owned-worktree-acquisition-temp`),
        journalPath: ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot),
        rootStagePath: NodePath.join(fixture.tmp, `.${base}.owned-worktree-root-stage`),
        rootConfigPath: NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'),
        configPath: NodePath.join(fixture.ownedWorktree, 'megarepo.kdl'),
        configName: 'megarepo.kdl',
      })
      expect(plan.steps.map((step) => step._tag)).toEqual([
        'WriteJournal',
        'GitWorktreeMove',
        'WriteJournal',
        'PublishManagedRoot',
        'WriteJournal',
        'GitWorktreeMove',
        'WriteJournal',
        'CreateConfigSymlink',
        'InvokeGenerate',
        'WriteJournal',
        'WriteJournal',
        'RemoveJournal',
      ])
      expect(plan.steps[1]).toEqual({
        _tag: 'GitWorktreeMove',
        bareRepo: fixture.bareRepo,
        fromPath: fixture.workspaceRoot,
        toPath: plan.tempPath,
      })
      expect(plan.steps[3]).toEqual({
        _tag: 'PublishManagedRoot',
        rootStagePath: plan.rootStagePath,
        workspaceRoot: fixture.workspaceRoot,
        reposPath: NodePath.join(plan.rootStagePath, 'repos'),
        manifestPath: NodePath.join(plan.rootStagePath, OWNED_WORKTREE_ROOT_MANIFEST),
      })
      expect(plan.steps[5]).toEqual({
        _tag: 'GitWorktreeMove',
        bareRepo: fixture.bareRepo,
        fromPath: plan.tempPath,
        toPath: fixture.ownedWorktree,
      })
    }).pipe(withNode),
  )

  it.effect('classifies a complete synthesized workspace without mutation', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* acquire(fixture)
      const before = yield* snapshotPlanningState(fixture)
      const plan = yield* planAcquisition(fixture)
      const after = yield* snapshotPlanningState(fixture)
      expect(after).toEqual(before)
      expect(plan).toEqual({
        _tag: 'AlreadySynthesized',
        workspaceRoot: fixture.workspaceRoot,
        ownedWorktree: fixture.ownedWorktree,
        tempPath: NodePath.join(
          fixture.tmp,
          `.${NodePath.basename(fixture.workspaceRoot)}.owned-worktree-acquisition-temp`,
        ),
        journalPath: ownedWorktreeAcquisitionJournalPath(fixture.workspaceRoot),
        rootStagePath: NodePath.join(
          fixture.tmp,
          `.${NodePath.basename(fixture.workspaceRoot)}.owned-worktree-root-stage`,
        ),
        rootConfigPath: NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'),
        configPath: NodePath.join(fixture.ownedWorktree, 'megarepo.kdl'),
        configName: 'megarepo.kdl',
      })
    }).pipe(withNode),
  )

  it.effect(
    'classifies rollback and journaled forward recovery without mutation',
    () =>
      Effect.gen(function* () {
        const rollbackFixture = yield* makeFixture()
        const rollbackSetup = yield* acquire(rollbackFixture, {
          runtime: {
            afterBoundary: async (boundary) => {
              if (boundary === 'RootCreated') throw new Error('interrupt before root journal')
            },
          },
        }).pipe(Effect.result)
        expect(rollbackSetup._tag).toBe('Failure')
        const rollbackBefore = yield* snapshotPlanningState(rollbackFixture)
        const rollbackPlan = yield* planAcquisition(rollbackFixture)
        expect(yield* snapshotPlanningState(rollbackFixture)).toEqual(rollbackBefore)
        expect(rollbackPlan._tag).toBe('Recover')
        if (rollbackPlan._tag === 'Recover') {
          expect(rollbackPlan.action).toBe('RollbackTemporary')
          expect(rollbackPlan.steps.map((step) => step._tag)).toEqual([
            'RemoveManagedRoot',
            'GitWorktreeMove',
            'RemoveJournal',
          ])
        }

        const forwardFixture = yield* makeFixture()
        const forwardSetup = yield* acquire(forwardFixture, {
          runtime: {
            afterBoundary: async (boundary) => {
              if (boundary === 'GeneratedJournaled') throw new Error('interrupt after generation')
            },
          },
        }).pipe(Effect.result)
        expect(forwardSetup._tag).toBe('Failure')
        const forwardBefore = yield* snapshotPlanningState(forwardFixture)
        const forwardPlan = yield* planAcquisition(forwardFixture)
        expect(yield* snapshotPlanningState(forwardFixture)).toEqual(forwardBefore)
        expect(forwardPlan._tag).toBe('Recover')
        if (forwardPlan._tag === 'Recover') {
          expect(forwardPlan.action).toBe('FinishGenerated')
          expect(forwardPlan.steps.map((step) => step._tag)).toEqual([
            'WriteJournal',
            'RemoveJournal',
          ])
        }

        for (const linkedBoundary of ['ConfigLinked', 'Generated'] as const) {
          const linkedFixture = yield* makeFixture()
          const linkedSetup = yield* acquire(linkedFixture, {
            runtime: {
              afterBoundary: async (boundary) => {
                if (boundary === linkedBoundary) throw new Error(`interrupt at ${boundary}`)
              },
            },
          }).pipe(Effect.result)
          expect(linkedSetup._tag, linkedBoundary).toBe('Failure')
          const linkedBefore = yield* snapshotPlanningState(linkedFixture)
          const linkedPlan = yield* planAcquisition(linkedFixture)
          expect(yield* snapshotPlanningState(linkedFixture)).toEqual(linkedBefore)
          expect(linkedPlan._tag, linkedBoundary).toBe('Recover')
          if (linkedPlan._tag === 'Recover') {
            expect(linkedPlan.action, linkedBoundary).toBe('RollForwardInstalled')
            expect(
              linkedPlan.steps.map((step) => step._tag),
              linkedBoundary,
            ).toEqual(['InvokeGenerate', 'WriteJournal', 'WriteJournal', 'RemoveJournal'])
          }
        }
      }).pipe(withNode),
    { timeout: 60_000 },
  )

  it.effect(
    'returns Refused for path and foreign recovery conflicts without mutation',
    () =>
      Effect.gen(function* () {
        const collisionFixture = yield* makeFixture()
        const collisionPath = NodePath.join(
          collisionFixture.tmp,
          `.${NodePath.basename(collisionFixture.workspaceRoot)}.owned-worktree-acquisition-temp`,
        )
        yield* Effect.promise(() => mkdir(collisionPath))
        const collisionBefore = yield* snapshotPlanningState(collisionFixture)
        const collisionPlan = yield* planAcquisition(collisionFixture)
        expect(yield* snapshotPlanningState(collisionFixture)).toEqual(collisionBefore)
        expect(collisionPlan._tag).toBe('Refused')
        if (collisionPlan._tag === 'Refused') expect(collisionPlan.error.reason).toBe('Collision')

        const foreignFixture = yield* makeFixture()
        yield* acquire(foreignFixture, {
          runtime: {
            afterBoundary: async (boundary) => {
              if (boundary === 'RootCreated') throw new Error('interrupt before foreign entry')
            },
          },
        }).pipe(Effect.result)
        yield* Effect.promise(() =>
          writeFile(NodePath.join(foreignFixture.workspaceRoot, 'foreign.txt'), 'foreign\n'),
        )
        const foreignBefore = yield* snapshotPlanningState(foreignFixture)
        const foreignPlan = yield* planAcquisition(foreignFixture)
        expect(yield* snapshotPlanningState(foreignFixture)).toEqual(foreignBefore)
        expect(foreignPlan._tag).toBe('Refused')
        if (foreignPlan._tag === 'Refused') {
          expect(foreignPlan.error.reason).toBe('ForeignRootEntry')
        }

        const lockedFixture = yield* makeFixture()
        yield* installOrphanAcquisitionLock({
          fixture: lockedFixture,
          token: 'f'.repeat(32),
          pid: process.pid,
        })
        const lockedBefore = yield* snapshotPlanningState(lockedFixture)
        const lockedPlan = yield* planAcquisition(lockedFixture)
        expect(yield* snapshotPlanningState(lockedFixture)).toEqual(lockedBefore)
        expect(lockedPlan._tag).toBe('Refused')
        if (lockedPlan._tag === 'Refused') {
          expect(lockedPlan.error.reason).toBe('AcquisitionLocked')
        }
      }).pipe(withNode),
    { timeout: 60_000 },
  )
})
