import { readdir, readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../../core/git.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import {
  assertComposedOwnedWorkspace,
  createComposedOwnedWorkspace,
  resolveStoreBranchWorktree,
  type OwnedWorkspaceGenerationContext,
} from './owned-worktree-acquisition.ts'

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

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const source = NodePath.join(tmp, 'source')
  const bareRepo = NodePath.join(tmp, 'repo.git')
  const workspaceRoot = NodePath.join(tmp, 'workspace')
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.kdl')),
    'members {}\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(tmp, 'clone', '--bare', source, bareRepo)
  return {
    source,
    tmp,
    bareRepo,
    workspaceRoot,
    ownedWorktree: NodePath.join(workspaceRoot, 'repos', 'owner'),
  }
})

const create = <E, R>(
  fixture: Effect.Success<typeof makeFixture>,
  generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>,
) =>
  createComposedOwnedWorkspace({
    bareRepo: fixture.bareRepo,
    workspaceRoot: fixture.workspaceRoot,
    ownedMember: 'owner',
    branch: 'feature',
    startPoint: 'main',
    generate,
  })
const installSmudge = (fixture: Effect.Success<typeof makeFixture>, scriptBody: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filter = NodePath.join(fixture.tmp, 'test-smudge')
    yield* fs.writeFileString(
      EffectPath.unsafe.absoluteFile(NodePath.join(fixture.source, '.gitattributes')),
      'payload.txt filter=test\n',
    )
    yield* fs.writeFileString(
      EffectPath.unsafe.absoluteFile(NodePath.join(fixture.source, 'payload.txt')),
      'payload\n',
    )
    yield* git(fixture.source, 'add', '-A')
    yield* git(fixture.source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'test filter')
    yield* git(fixture.bareRepo, 'fetch', fixture.source, '+refs/heads/main:refs/heads/main')
    yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(filter), `#!/bin/sh\n${scriptBody}\n`)
    yield* fs.chmod(EffectPath.unsafe.absoluteFile(filter), 0o755)
    yield* git(fixture.bareRepo, 'config', 'filter.test.smudge', filter)
    yield* git(fixture.bareRepo, 'config', 'filter.test.required', 'true')
    return filter
  })

const installBlockingSmudge = (fixture: Effect.Success<typeof makeFixture>) =>
  installSmudge(fixture, 'sleep 60\ncat')

const waitForInitializationLock = (fixture: Effect.Success<typeof makeFixture>) =>
  Effect.tryPromise(async () => {
    const adminRoot = NodePath.join(fixture.bareRepo, 'worktrees')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const adminNames = await readdir(adminRoot).catch(() => [])
      for (const adminName of adminNames) {
        const lockPath = NodePath.join(adminRoot, adminName, 'locked')
        const reason = await readFile(lockPath, 'utf8').catch(() => undefined)
        if (reason?.startsWith('initializing') === true) {
          return { lockPath, reason: reason.trim() }
        }
      }
      await delay(10)
    }
    throw new Error('Timed out waiting for the initializing worktree lock')
  })

describe('direct composed worktree creation', () => {
  it.effect('resolves an absent unregistered root as the creatable canonical P', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      expect(
        yield* resolveStoreBranchWorktree({
          bareRepo: fixture.bareRepo,
          workspaceRoot: fixture.workspaceRoot,
          branch: 'feature',
        }),
      ).toBe(`${fixture.workspaceRoot}/`)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('atomically assigns a new branch to one creator', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const expectedOid = yield* Git.resolveRef({
        repoPath: fixture.bareRepo,
        ref: 'main^{commit}',
      })
      const claims = yield* Effect.all(
        [
          Git.createBranchIfAbsent({
            repoPath: fixture.bareRepo,
            branch: 'feature',
            expectedOid,
          }).pipe(Effect.exit),
          Git.createBranchIfAbsent({
            repoPath: fixture.bareRepo,
            branch: 'feature',
            expectedOid,
          }).pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      )
      expect(claims.filter(Exit.isSuccess)).toHaveLength(1)
      expect(yield* Git.resolveRef({ repoPath: fixture.bareRepo, ref: 'feature' })).toBe(
        expectedOid,
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('creates Git directly at the stable final W path and links the root config', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      const result = yield* create(fixture, () => Effect.void)
      expect(result.ownedWorktree).toBe(fixture.ownedWorktree)
      expect(yield* fs.readLink(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'))).toBe(
        'repos/owner/megarepo.kdl',
      )
      const registrations = yield* Git.listWorktrees(fixture.bareRepo)
      expect(registrations.some((entry) => entry.path === fixture.ownedWorktree)).toBe(true)
      expect(
        yield* resolveStoreBranchWorktree({
          bareRepo: fixture.bareRepo,
          workspaceRoot: fixture.workspaceRoot,
          branch: 'feature',
        }),
      ).toBe(`${fixture.ownedWorktree}/`)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rolls back failed generation even with a stale index lock and permits retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      const failure = yield* create(fixture, ({ ownedWorktree }) =>
        Effect.gen(function* () {
          const dotGit = NodePath.join(ownedWorktree, '.git')
          const pointer = (yield* fs.readFileString(EffectPath.unsafe.absoluteFile(dotGit))).trim()
          const adminDir = NodePath.resolve(
            NodePath.dirname(dotGit),
            pointer.slice('gitdir: '.length),
          )
          yield* fs.writeFileString(
            EffectPath.unsafe.absoluteFile(NodePath.join(adminDir, 'index.lock')),
            '',
          )
          return yield* Effect.fail('interrupted')
        }),
      ).pipe(Effect.flip)
      expect(failure.reason).toBe('GenerationFailed')
      expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
        false,
      )
      expect(yield* Git.listWorktrees(fixture.bareRepo)).toHaveLength(0)
      expect(yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' })).toBe(
        false,
      )

      const result = yield* create(fixture, () => Effect.void)
      expect(result.ownedWorktree).toBe(fixture.ownedWorktree)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rolls back an interrupted generation and permits a fresh retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      const generationStarted = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        create(fixture, () =>
          Deferred.succeed(generationStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      )
      yield* Deferred.await(generationStarted)
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
        false,
      )
      expect(yield* Git.listWorktrees(fixture.bareRepo)).toHaveLength(0)
      expect(yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' })).toBe(
        false,
      )
      expect((yield* create(fixture, () => Effect.void)).ownedWorktree).toBe(fixture.ownedWorktree)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains a pre-existing branch after generation rollback', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* git(fixture.bareRepo, 'branch', 'feature', 'main')
      const featureOid = yield* Git.resolveRef({
        repoPath: fixture.bareRepo,
        ref: 'feature^{commit}',
      })

      const failure = yield* create(fixture, () => Effect.fail('generation failed')).pipe(
        Effect.flip,
      )
      expect(failure.reason).toBe('GenerationFailed')
      expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
        false,
      )
      expect(yield* Git.listWorktrees(fixture.bareRepo)).toHaveLength(0)
      expect(yield* Git.resolveRef({ repoPath: fixture.bareRepo, ref: 'feature^{commit}' })).toBe(
        featureOid,
      )
      expect((yield* create(fixture, () => Effect.void)).ownedWorktree).toBe(fixture.ownedWorktree)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'rolls back a locked initializing birth interrupted during checkout',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* makeFixture
        const filter = yield* installBlockingSmudge(fixture)
        expect(yield* git(fixture.bareRepo, 'show', 'main:.gitattributes')).toContain(
          'payload.txt filter=test',
        )
        expect(yield* git(fixture.bareRepo, 'config', '--get', 'filter.test.smudge')).toBe(filter)
        const fiber = yield* Effect.forkChild(create(fixture, () => Effect.void))
        yield* waitForInitializationLock(fixture)
        yield* Fiber.interrupt(fiber)
        const interrupted = yield* Fiber.await(fiber)
        expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)

        expect(
          (yield* Git.listWorktrees(fixture.bareRepo)).filter(
            (entry) => Option.getOrUndefined(entry.branch) === 'feature',
          ),
        ).toEqual([])
        expect(
          yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' }),
        ).toBe(false)
        expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
          false,
        )
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  )

  it.effect('removes an empty unregistered checkout remnant before retry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* installSmudge(fixture, 'exit 1')

      const failed = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failed.reason).toBe('CommandFailure')
      expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
        false,
      )
      expect(yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' })).toBe(
        false,
      )

      yield* git(fixture.bareRepo, 'config', 'filter.test.smudge', 'cat')
      expect((yield* create(fixture, () => Effect.void)).ownedWorktree).toBe(fixture.ownedWorktree)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'preserves a replacement registration carrying another initialization token',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* makeFixture
        const gate = NodePath.join(fixture.tmp, 'release-filter')
        yield* installSmudge(fixture, `while [ ! -f '${gate}' ]; do sleep 0.01; done\ncat`)
        const fiber = yield* Effect.forkChild(create(fixture, () => Effect.void))
        const { lockPath, reason } = yield* waitForInitializationLock(fixture)
        expect(reason).toMatch(
          /^initializing:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        )

        const replacementReason = 'initializing'
        yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(lockPath), replacementReason)
        yield* fs.writeFileString(
          EffectPath.unsafe.absoluteFile(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl')),
          'foreign\n',
        )
        yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(gate), '')
        const failed = yield* Fiber.join(fiber).pipe(Effect.flip)
        expect(failed.reason).toBe('ConfigSymlinkInvalid')

        const registration = (yield* Git.listWorktrees(fixture.bareRepo)).find(
          (entry) => Option.getOrUndefined(entry.branch) === 'feature',
        )
        expect(registration).toBeDefined()
        expect(Option.getOrUndefined(registration?.lockReason ?? Option.none())).toBe(
          replacementReason,
        )
        expect(
          yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' }),
        ).toBe(true)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  )

  it.effect('rolls back checkout setup failure while the initialization token is held', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* fs.remove(
        EffectPath.unsafe.absoluteFile(NodePath.join(fixture.source, 'megarepo.kdl')),
      )
      yield* git(fixture.source, 'add', '-A')
      yield* git(fixture.source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'remove config')
      yield* git(fixture.bareRepo, 'fetch', fixture.source, '+refs/heads/main:refs/heads/main')

      const failed = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failed.reason).toBe('ConfigMissing')
      expect(
        (yield* Git.listWorktrees(fixture.bareRepo)).filter(
          (entry) => Option.getOrUndefined(entry.branch) === 'feature',
        ),
      ).toEqual([])
      expect(yield* Git.refExists({ repoPath: fixture.bareRepo, ref: 'refs/heads/feature' })).toBe(
        false,
      )
      expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
        false,
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'removes its interrupted checkout but retains a pre-existing branch',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* makeFixture
        yield* installBlockingSmudge(fixture)
        yield* git(fixture.bareRepo, 'branch', 'feature', 'main')
        const featureOid = yield* Git.resolveRef({
          repoPath: fixture.bareRepo,
          ref: 'feature^{commit}',
        })

        const fiber = yield* Effect.forkChild(create(fixture, () => Effect.void))
        yield* waitForInitializationLock(fixture)
        yield* Fiber.interrupt(fiber)

        expect(
          (yield* Git.listWorktrees(fixture.bareRepo)).filter(
            (entry) => Option.getOrUndefined(entry.branch) === 'feature',
          ),
        ).toEqual([])
        expect(yield* Git.resolveRef({ repoPath: fixture.bareRepo, ref: 'feature^{commit}' })).toBe(
          featureOid,
        )
        expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`))).toBe(
          false,
        )
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  )

  it.effect('uses physical identity below a symlinked store root', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      const linkedStore = NodePath.join(fixture.tmp, 'linked-store')
      yield* fs.symlink(fixture.tmp, linkedStore)
      const linkedWorkspaceRoot = NodePath.join(linkedStore, 'workspace')
      const linkedBareRepo = NodePath.join(linkedStore, 'repo.git')

      const result = yield* createComposedOwnedWorkspace({
        bareRepo: linkedBareRepo,
        workspaceRoot: linkedWorkspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
        startPoint: 'main',
        generate: () => Effect.void,
      })

      expect(result.workspaceRoot).toBe(fixture.workspaceRoot)
      expect(result.ownedWorktree).toBe(fixture.ownedWorktree)
      const dotGit = NodePath.join(fixture.ownedWorktree, '.git')
      const pointer = (yield* fs.readFileString(EffectPath.unsafe.absoluteFile(dotGit))).trim()
      const adminDir = NodePath.resolve(NodePath.dirname(dotGit), pointer.slice('gitdir: '.length))
      const linkedOwnedWorktree = NodePath.join(linkedWorkspaceRoot, 'repos', 'owner')
      yield* fs.writeFileString(
        EffectPath.unsafe.absoluteFile(NodePath.join(adminDir, 'gitdir')),
        `${linkedOwnedWorktree}/.git\n`,
      )
      expect(
        (yield* Git.listWorktrees(fixture.bareRepo)).find(
          (registration) => Option.getOrUndefined(registration.branch) === 'feature',
        )?.path,
      ).toBe(linkedOwnedWorktree)
      yield* createComposedOwnedWorkspace({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
        startPoint: 'main',
        generate: () => Effect.void,
      })
      expect(
        yield* resolveStoreBranchWorktree({
          bareRepo: linkedBareRepo,
          workspaceRoot: linkedWorkspaceRoot,
          branch: 'feature',
        }),
      ).toBe(`${fixture.ownedWorktree}/`)
      expect(
        (yield* assertComposedOwnedWorkspace({
          bareRepo: linkedBareRepo,
          workspaceRoot: linkedWorkspaceRoot,
          ownedMember: 'owner',
          branch: 'feature',
        })).workspaceRoot,
      ).toBe(fixture.workspaceRoot)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'rejects an existing P after its worktree registration is lost without deleting it',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* makeFixture
        yield* create(fixture, () => Effect.void)
        const dotGit = NodePath.join(fixture.ownedWorktree, '.git')
        const pointer = (yield* fs.readFileString(EffectPath.unsafe.absoluteFile(dotGit))).trim()
        const adminDir = NodePath.resolve(
          NodePath.dirname(dotGit),
          pointer.slice('gitdir: '.length),
        )
        const preserved = NodePath.join(fixture.ownedWorktree, 'preserved.txt')
        yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(preserved), 'keep\n')
        yield* fs.remove(EffectPath.unsafe.absoluteDir(`${adminDir}/`), { recursive: true })

        const failure = yield* resolveStoreBranchWorktree({
          bareRepo: fixture.bareRepo,
          workspaceRoot: fixture.workspaceRoot,
          branch: 'feature',
        }).pipe(Effect.flip)
        expect(failure.reason).toBe('GitIdentityConflict')
        expect(yield* fs.readFileString(EffectPath.unsafe.absoluteFile(preserved))).toBe('keep\n')
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rejects a linked-worktree admin directory with a non-reciprocal backlink', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* create(fixture, () => Effect.void)
      const dotGit = NodePath.join(fixture.ownedWorktree, '.git')
      const pointer = (yield* fs.readFileString(EffectPath.unsafe.absoluteFile(dotGit))).trim()
      const adminDir = NodePath.resolve(NodePath.dirname(dotGit), pointer.slice('gitdir: '.length))
      yield* fs.writeFileString(
        EffectPath.unsafe.absoluteFile(NodePath.join(adminDir, 'gitdir')),
        `${NodePath.join(fixture.tmp, 'swapped', '.git')}\n`,
      )

      const failure = yield* assertComposedOwnedWorkspace({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('GitIdentityConflict')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses foreign root bytes before Git creation and leaves them untouched', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`), {
        recursive: true,
      })
      const foreign = NodePath.join(fixture.workspaceRoot, 'foreign.txt')
      yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(foreign), 'keep\n')
      const failure = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failure.reason).toBe('ForeignRoot')
      expect(yield* fs.readFileString(EffectPath.unsafe.absoluteFile(foreign))).toBe('keep\n')
      expect(yield* Git.listWorktrees(fixture.bareRepo)).toHaveLength(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses a branch registered at any path other than W', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const elsewhere = NodePath.join(fixture.tmp, 'elsewhere')
      yield* git(fixture.bareRepo, 'worktree', 'add', '-b', 'feature', elsewhere, 'main')
      const failure = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failure.reason).toBe('GitIdentityConflict')
      expect(failure.message).toContain(elsewhere)
      const resolutionFailure = yield* resolveStoreBranchWorktree({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(resolutionFailure.reason).toBe('GitIdentityConflict')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rejects duplicate registrations for the owned branch', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      yield* create(fixture, () => Effect.void)
      const duplicate = NodePath.join(fixture.tmp, 'duplicate')
      yield* git(fixture.bareRepo, 'worktree', 'add', '--force', '--force', duplicate, 'feature')

      const assertionFailure = yield* assertComposedOwnedWorkspace({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(assertionFailure.reason).toBe('GitIdentityConflict')

      const resolutionFailure = yield* resolveStoreBranchWorktree({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(resolutionFailure.reason).toBe('GitIdentityConflict')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rejects a mismatched root config symlink after Git authority exists', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* create(fixture, () => Effect.void)
      const rootConfig = NodePath.join(fixture.workspaceRoot, 'megarepo.kdl')
      yield* fs.remove(rootConfig)
      yield* fs.symlink('foreign', rootConfig)
      const failure = yield* assertComposedOwnedWorkspace({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('ConfigSymlinkInvalid')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
