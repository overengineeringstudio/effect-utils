/**
 * Integration tests for the lossless floor (U3, decision 0001).
 *
 * These exercise REAL git: a bare repo wired to a separate upstream so it has
 * real `refs/remotes/origin/*`, plus worktrees whose HEADs we drive precisely.
 * The headline case is "B1": a local commit stacked on a parent that lives on an
 * UNRELATED remote ref must still count as unpushed (`> 0`) — the exact
 * distinction `rev-list --not --remotes` draws that `branch -r --contains` does
 * not.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { FIXTURE_BRANCH, initFixtureRepo, pushFixtureBranch } from '../test-utils/git-fixture.ts'
import { assessLossless, hasStash, unpushedCommitCount } from './store-lossless.ts'

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const

/** Run git in `cwd`, returning trimmed stdout. */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make('git', [...GIT_USER, ...args], { cwd })),
    )
    return result.trim()
  })

/** Build Git's two-parent stash shape without invoking the managed keyed-stash UI. */
const createFixtureStash = Effect.fnUntraced(function* (cwd: AbsoluteDirPath) {
  const head = yield* git(cwd, 'rev-parse', 'HEAD')
  const indexTree = yield* git(cwd, 'write-tree')
  const indexCommit = yield* git(cwd, 'commit-tree', indexTree, '-p', head, '-m', 'fixture index')
  yield* git(cwd, 'add', 'f.txt')
  const worktreeTree = yield* git(cwd, 'write-tree')
  const stashCommit = yield* git(
    cwd,
    'commit-tree',
    worktreeTree,
    '-p',
    head,
    '-p',
    indexCommit,
    '-m',
    'fixture stash',
  )
  yield* git(cwd, 'update-ref', 'refs/stash', stashCommit)
})

/**
 * Build a store-like bare repo wired to a separate upstream (real
 * `refs/remotes/origin/*`) with an initial pushed commit on `fixture-main`.
 *
 * Returns the bare path, the upstream path, the source repo path (still wired to
 * the upstream so the test can push more branches), and the initial commit SHA.
 */
const makeWiredBare = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

  const upstream = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('upstream.bare/'))
  const bare = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('store.bare/'))
  const source = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('source/'))

  // Keep the remote HEAD deterministic without using a protected branch name.
  yield* fs.makeDirectory(upstream, { recursive: true })
  yield* git(upstream, 'init', '--bare', '-b', FIXTURE_BRANCH)

  yield* fs.makeDirectory(source, { recursive: true })
  yield* initFixtureRepo(source)
  yield* fs.writeFileString(
    EffectPath.ops.join(source, EffectPath.unsafe.relativeFile('f.txt')),
    'base\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(source, 'remote', 'add', 'origin', upstream)
  yield* pushFixtureBranch(source)
  const baseCommit = yield* git(source, 'rev-parse', 'HEAD')

  // Wire the bare to the upstream with a fetching refspec (mirrors Git.cloneBare).
  yield* fs.makeDirectory(bare, { recursive: true })
  yield* git(bare, 'init', '--bare', '-b', FIXTURE_BRANCH)
  yield* git(bare, 'remote', 'add', 'origin', upstream)
  yield* git(bare, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  yield* git(bare, 'fetch', '--tags', '--prune', 'origin')

  return { bare, upstream, source, baseCommit }
})

/** Add a worktree at `ref` under `bare`/wt-`name`. */
const addWorktree = (args: { bare: AbsoluteDirPath; name: string; ref: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const wt = EffectPath.ops.join(args.bare, EffectPath.unsafe.relativeDir(`../wt-${args.name}/`))
    yield* fs.makeDirectory(wt, { recursive: true })
    yield* git(args.bare, 'worktree', 'add', '--detach', wt, args.ref)
    return wt
  })

describe('store-lossless', () => {
  it.effect(
    'unpushedCommitCount is 0 for a head fully on a remote branch',
    Effect.fnUntraced(
      function* () {
        const { bare, baseCommit } = yield* makeWiredBare()
        const count = yield* unpushedCommitCount({
          bareRepoPath: bare,
          worktreeHead: baseCommit,
        })
        expect(count).toBe(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'B1: a local commit on top of an unrelated-remote-contained parent counts as unpushed',
    Effect.fnUntraced(
      function* () {
        const { bare, source } = yield* makeWiredBare()

        // Push the base commit to an UNRELATED remote branch `other` (not the default branch's
        // tip, but here equal). The point: the worktree's NEW commit's parent is
        // reachable via a remote ref, yet the new commit itself is not pushed.
        yield* git(source, 'push', 'origin', `${FIXTURE_BRANCH}:other`)
        yield* git(bare, 'fetch', '--prune', 'origin')
        const otherTip = yield* git(bare, 'rev-parse', 'refs/remotes/origin/other')

        const wt = yield* addWorktree({ bare, name: 'b1', ref: otherTip })
        // Stack one genuinely-local commit on top.
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            fs.writeFileString(
              EffectPath.ops.join(wt, EffectPath.unsafe.relativeFile('f.txt')),
              'local work\n',
            ),
          ),
        )
        yield* git(wt, 'commit', '-a', '--no-gpg-sign', '--no-verify', '-m', 'local-only')
        const wtHead = yield* git(wt, 'rev-parse', 'HEAD')

        const count = yield* unpushedCommitCount({ bareRepoPath: bare, worktreeHead: wtHead })
        // Exactly the one new commit is unpushed; the unrelated-remote parent is excluded.
        expect(count).toBe(1)

        const assessment = yield* assessLossless({
          bareRepoPath: bare,
          worktreePath: wt,
          worktreeHead: wtHead,
        })
        expect(assessment.unpushed).toBe(1)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'squash-merge style: remote branch deleted but commit reachable via another remote ref ⇒ unpushed 0',
    Effect.fnUntraced(
      function* () {
        const { bare, source } = yield* makeWiredBare()

        // Create a feature branch on the upstream, fetch it, then DELETE it from
        // the upstream and prune — but the same commit is also on the default branch.
        yield* git(source, 'push', 'origin', `${FIXTURE_BRANCH}:feature`)
        yield* git(bare, 'fetch', '--prune', 'origin')
        const featureTip = yield* git(bare, 'rev-parse', 'refs/remotes/origin/feature')

        const wt = yield* addWorktree({ bare, name: 'squash', ref: featureTip })
        const wtHead = yield* git(wt, 'rev-parse', 'HEAD')

        // Delete the feature branch upstream and prune the remote-tracking ref.
        yield* git(source, 'push', 'origin', '--delete', 'feature')
        yield* git(bare, 'fetch', '--prune', 'origin')

        const count = yield* unpushedCommitCount({ bareRepoPath: bare, worktreeHead: wtHead })
        // Still reachable via the default remote branch ⇒ recoverable ⇒ 0.
        expect(count).toBe(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'unpushedCommitCount reports all commits when the bare has no remote-tracking refs (conservative)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const bare = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('lonely.bare/'))
        const source = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('src/'))

        // A bare with a branch but NO refs/remotes/* (never fetched a remote).
        yield* fs.makeDirectory(bare, { recursive: true })
        yield* git(bare, 'init', '--bare', '-b', FIXTURE_BRANCH)
        yield* fs.makeDirectory(source, { recursive: true })
        yield* initFixtureRepo(source)
        yield* fs.writeFileString(
          EffectPath.ops.join(source, EffectPath.unsafe.relativeFile('f.txt')),
          'x\n',
        )
        yield* git(source, 'add', '-A')
        yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'c0')
        yield* git(source, 'remote', 'add', 'origin', bare)
        yield* pushFixtureBranch(source)
        const head = yield* git(bare, 'rev-parse', `refs/heads/${FIXTURE_BRANCH}`)

        const count = yield* unpushedCommitCount({ bareRepoPath: bare, worktreeHead: head })
        // No remote-tracking refs ⇒ everything reads as unpushed ⇒ keep.
        expect(count).toBeGreaterThan(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'hasStash is false without a stash and true with a real refs/stash',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { bare, baseCommit } = yield* makeWiredBare()

        expect(yield* hasStash({ bareRepoPath: bare })).toBe(false)

        // Create a worktree, dirty it, and stash — producing refs/stash in the bare.
        const wt = yield* addWorktree({ bare, name: 'stash', ref: baseCommit })
        yield* fs.writeFileString(
          EffectPath.ops.join(wt, EffectPath.unsafe.relativeFile('f.txt')),
          'dirty\n',
        )
        yield* createFixtureStash(wt)

        expect(yield* hasStash({ bareRepoPath: bare })).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'assessLossless surfaces dirt and a present stash together',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { bare, baseCommit } = yield* makeWiredBare()

        const wt = yield* addWorktree({ bare, name: 'assess', ref: baseCommit })
        const wtHead = yield* git(wt, 'rev-parse', 'HEAD')

        // Stash some work (creates refs/stash), then leave NEW dirt behind.
        yield* fs.writeFileString(
          EffectPath.ops.join(wt, EffectPath.unsafe.relativeFile('f.txt')),
          'to-stash\n',
        )
        yield* createFixtureStash(wt)
        yield* fs.writeFileString(
          EffectPath.ops.join(wt, EffectPath.unsafe.relativeFile('untracked.txt')),
          'new dirt\n',
        )

        const assessment = yield* assessLossless({
          bareRepoPath: bare,
          worktreePath: wt,
          worktreeHead: wtHead,
        })

        expect(assessment).toEqual({ unpushed: 0, dirty: true, hasStash: true })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
