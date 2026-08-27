import { mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { findMegarepoRoot } from '../cli/context.ts'
import * as Git from './git.ts'
import { OWNED_WORKTREE_ROOT_MANIFEST } from './owned-worktree-acquisition-schema.ts'
import {
  acquireOwnedWorktree,
  ownedWorktreeAcquisitionJournalPath,
  recoverOwnedWorktreeAcquisition,
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

const status = (path: string) =>
  Git.runCommand({
    cwd: path,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
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
          expect(recovered._tag, boundaryToFail).toBe('RolledForward')
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
})
