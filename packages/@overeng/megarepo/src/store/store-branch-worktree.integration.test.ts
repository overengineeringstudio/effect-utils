import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { resolveStoreBranchWorktree } from './store-branch-worktree.ts'

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
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.kdl')),
    'members {}\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(tmp, 'clone', '--bare', source, bareRepo)
  return { tmp, bareRepo, worktreePath: NodePath.join(tmp, 'refs', 'heads', 'feature') }
})

describe('resolveStoreBranchWorktree', () => {
  it.effect('resolves an absent unregistered path as the creatable canonical path', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      expect(
        yield* resolveStoreBranchWorktree({
          bareRepo: fixture.bareRepo,
          worktreePath: fixture.worktreePath,
          branch: 'feature',
        }),
      ).toBe(`${fixture.worktreePath}/`)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses a branch registered at any path other than the canonical one', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const elsewhere = NodePath.join(fixture.tmp, 'elsewhere')
      yield* git(fixture.bareRepo, 'worktree', 'add', '-b', 'feature', elsewhere, 'main')
      const failure = yield* resolveStoreBranchWorktree({
        bareRepo: fixture.bareRepo,
        worktreePath: fixture.worktreePath,
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('GitIdentityConflict')
      expect(failure.message).toContain(elsewhere)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
