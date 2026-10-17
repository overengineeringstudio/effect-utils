import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { decodeJson, encodeJson } from '../../test-utils/json.ts'
import { addCommit, initGitRepo, runGitCommand } from '../../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import { MegarepoConfig } from '../config.ts'
import { LockFile, LockedMember } from '../lock.ts'
import { syncNixLocks } from './mod.ts'

const rev = 'a'.repeat(40)
const originalLock = encodeJson({
  version: 7,
  root: 'root',
  nodes: {
    root: { inputs: { dep: 'dep' } },
    dep: {
      locked: { type: 'git', url: 'https://github.com/acme/dep', rev },
      original: { type: 'git', url: 'https://github.com/acme/dep', ref: 'main' },
    },
  },
})
const originalSource = `{ inputs.dep.url = "github:acme/dep/main?rev=${'b'.repeat(40)}"; }\n`

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* makeCanonicalTempDirectoryScoped()
  const seed = EffectPath.unsafe.absoluteDir(`${root}/seed/`)
  yield* fs.makeDirectory(seed)
  yield* initGitRepo(seed)
  yield* runGitCommand(seed, 'checkout', '-B', 'main')
  yield* fs.writeFileString(`${seed}README`, 'fixture\n')
  yield* addCommit({ repoPath: seed, message: 'Initial fixture' })
  const repo = `${root}/store/example.com/org/repo`
  yield* fs.makeDirectory(repo, { recursive: true })
  yield* runGitCommand(seed, 'clone', '--bare', seed, `${repo}/.bare`)
  const bare = EffectPath.unsafe.absoluteDir(`${repo}/.bare/`)
  const author = EffectPath.unsafe.absoluteDir(`${repo}/refs/heads/topic/author/`)
  const shared = EffectPath.unsafe.absoluteDir(`${repo}/refs/heads/main/`)
  const tag = EffectPath.unsafe.absoluteDir(`${repo}/refs/tags/v1/`)
  const commit = EffectPath.unsafe.absoluteDir(`${repo}/refs/commits/${rev}/`)
  yield* runGitCommand(bare, 'worktree', 'add', '-b', 'topic/author', author, 'main')
  yield* runGitCommand(bare, 'worktree', 'add', shared, 'main')
  yield* runGitCommand(bare, 'tag', 'v1', 'main')
  yield* runGitCommand(bare, 'worktree', 'add', '--detach', tag, 'v1')
  yield* runGitCommand(bare, 'worktree', 'add', '--detach', commit, 'main')
  const workspace = EffectPath.unsafe.absoluteDir(`${root}/workspace/`)
  yield* fs.makeDirectory(`${workspace}repos`, { recursive: true })
  return { root, workspace, author, shared, tag, commit }
})

const sync = (megarepoRoot: AbsoluteDirPath) =>
  syncNixLocks({
    megarepoRoot,
    config: new MegarepoConfig({ members: { member: './member' } }),
    lockFile: new LockFile({
      version: 1,
      members: {
        dep: new LockedMember({
          url: 'https://github.com/acme/dep',
          ref: 'main',
          commit: rev,
          pinned: false,
          lockedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    }),
  })

describe('Nix lock author workspace writes', () => {
  it.effect('rewrites both lock formats and source revisions in the owning author worktree', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { workspace, author } = yield* makeFixture
      yield* fs.symlink(author, `${workspace}repos/member`)
      for (const filename of ['flake.lock', 'devenv.lock']) {
        yield* fs.writeFileString(`${author}${filename}`, originalLock)
      }
      yield* fs.writeFileString(`${author}flake.nix`, originalSource)
      const beforeHead = yield* runGitCommand(author, 'rev-parse', 'HEAD')
      const result = yield* sync(workspace)
      expect(result.memberResults).toHaveLength(1)
      for (const filename of ['flake.lock', 'devenv.lock']) {
        expect(decodeJson(yield* fs.readFileString(`${author}${filename}`))).toMatchObject({
          nodes: { dep: { locked: { type: 'github', owner: 'acme', repo: 'dep', rev } } },
        })
      }
      expect(yield* fs.readFileString(`${author}flake.nix`)).toContain(`?rev=${rev}`)
      expect(yield* runGitCommand(author, 'rev-parse', 'HEAD')).toBe(beforeHead)
      expect(yield* runGitCommand(author, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic/author')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses shared default, tag and commit worktrees without changing either lock', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { workspace, shared, tag, commit } = yield* makeFixture
      for (const target of [shared, tag, commit]) {
        yield* fs.symlink(target, `${workspace}repos/member`)
        for (const filename of ['flake.lock', 'devenv.lock']) {
          yield* fs.writeFileString(`${target}${filename}`, originalLock)
        }
        expect(Exit.isFailure(yield* Effect.exit(sync(workspace)))).toBe(true)
        for (const filename of ['flake.lock', 'devenv.lock']) {
          expect(yield* fs.readFileString(`${target}${filename}`)).toBe(originalLock)
        }
        yield* fs.remove(`${workspace}repos/member`)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('preflights escaped output aliases before any author lock rewrite', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { root, workspace, author } = yield* makeFixture
      yield* fs.symlink(author, `${workspace}repos/member`)
      yield* fs.writeFileString(`${author}flake.lock`, originalLock)
      // An ordinary destination is still outside this member's ownership grant.
      const outside = `${root}/outside.lock`
      yield* fs.writeFileString(outside, originalLock)
      yield* fs.symlink(outside, `${author}devenv.lock`)
      expect(Exit.isFailure(yield* Effect.exit(sync(workspace)))).toBe(true)
      expect(yield* fs.readFileString(`${author}flake.lock`)).toBe(originalLock)
      expect(yield* fs.readFileString(outside)).toBe(originalLock)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
