import { execFileSync } from 'node:child_process'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { withGitWriterLock } from './git-writer-lock.ts'

/** More tags than fit in a socket buffer as `[new tag]` lines (~60 bytes each). */
const TAG_COUNT = 10_000

const git = (cwd: string, ...args: ReadonlyArray<string>) => Git.runCommand({ args, cwd })

/**
 * Upstream bare with commits A and B on `main`, tag `edge` at A, and `TAG_COUNT`
 * lightweight tags under `refs/tags/evidence/*`; the store bare tracks branches only.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const upstream = `${root}/upstream.git`
  const bare = `${root}/store.bare`
  yield* git(root, 'init', '--bare', '--initial-branch=main', upstream)
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: upstream,
    input: [
      'commit refs/heads/main',
      'committer T <t@example.com> 1700000000 +0000',
      'data 1',
      'A',
      'commit refs/heads/main',
      'committer T <t@example.com> 1700000001 +0000',
      'data 1',
      'B',
      '',
    ].join('\n'),
  })
  const commitA = yield* git(upstream, 'rev-parse', 'main~1')
  const commitB = yield* git(upstream, 'rev-parse', 'main')
  execFileSync('git', ['update-ref', '--stdin'], {
    cwd: upstream,
    input: Array.from(
      { length: TAG_COUNT },
      (_, index) => `create refs/tags/evidence/${index} ${commitA}\n`,
    ).join(''),
  })
  yield* git(upstream, 'update-ref', 'refs/tags/edge', commitA)
  yield* git(root, 'init', '--bare', '--initial-branch=main', bare)
  yield* git(bare, 'remote', 'add', 'origin', `file://${upstream}`)
  yield* git(bare, 'config', 'remote.origin.fetch', Git.bareOriginFetchRefspec)
  return { root, upstream, bare, commitA, commitB }
})

const tagCount = (repoPath: string) =>
  git(repoPath, 'for-each-ref', '--format=%(refname)', 'refs/tags').pipe(
    Effect.map((out) => (out === '' ? 0 : out.split('\n').length)),
  )

describe('store fetch', () => {
  it.effect(
    'many-tags fetch does not request all tags',
    () =>
      Effect.gen(function* () {
        const { bare, commitB } = yield* fixture

        yield* Git.fetchBare({ repoPath: bare, refs: ['main'] })

        expect(yield* git(bare, 'rev-parse', 'refs/remotes/origin/main')).toBe(commitB)
        expect(yield* tagCount(bare)).toBe(0)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  )

  it.effect(
    'locked git writer with more stderr than a socket buffer completes',
    () =>
      Effect.gen(function* () {
        const { bare } = yield* fixture

        // One `[new tag]` stderr line per tag and no stdout: a sequential stdout-then-stderr
        // drain deadlocks here with git blocked writing to its stderr socket.
        yield* git(bare, 'fetch', '--tags', 'origin').pipe(withGitWriterLock({ path: bare }))

        expect(yield* tagCount(bare)).toBe(TAG_COUNT + 1)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    60_000,
  )

  it.effect('moving tag pinned explicitly updates', () =>
    Effect.gen(function* () {
      const { upstream, bare, commitA, commitB } = yield* fixture
      yield* git(bare, 'fetch', 'origin', '+refs/tags/edge:refs/tags/edge')
      yield* git(upstream, 'update-ref', 'refs/tags/edge', commitB)

      // A blanket tag fetch refuses the upstream move.
      const blanket = yield* git(bare, 'fetch', '--tags', 'origin').pipe(Effect.flip)
      expect(blanket.message).toContain('would clobber existing tag')

      // A branch fetch neither fails on nor touches the unrequested tag.
      yield* Git.fetchBare({ repoPath: bare })
      expect(yield* git(bare, 'rev-parse', 'refs/tags/edge')).toBe(commitA)

      // The pinned tag follows the remote, the source of truth for a cache store.
      yield* Git.fetchBare({ repoPath: bare, refs: ['edge'] })
      expect(yield* git(bare, 'rev-parse', 'refs/tags/edge')).toBe(commitB)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('ref without a remote tag falls back to the branch fetch', () =>
    Effect.gen(function* () {
      const { upstream, bare, commitB } = yield* fixture
      yield* git(upstream, 'update-ref', 'refs/heads/later', commitB)

      yield* Git.fetchBare({ repoPath: bare, refs: ['later'] })

      expect(yield* git(bare, 'rev-parse', 'refs/remotes/origin/later')).toBe(commitB)
      expect(yield* tagCount(bare)).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  // `it.live`: the network deadline and the lock wait follow wall time, not a TestClock.
  it.live(
    'stalled peer fails within the network deadline and releases the writer lock',
    () =>
      Effect.gen(function* () {
        const { bare } = yield* fixture
        // The transport never answers; `sleep` inherits the lock descriptor from git.
        yield* git(bare, 'remote', 'set-url', 'origin', 'ext::sleep 3600')
        yield* git(bare, 'config', 'protocol.ext.allow', 'always')
        const previous = process.env.MEGAREPO_GIT_NETWORK_TIMEOUT_MS
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.MEGAREPO_GIT_NETWORK_TIMEOUT_MS = '1500'
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.MEGAREPO_GIT_NETWORK_TIMEOUT_MS
              else process.env.MEGAREPO_GIT_NETWORK_TIMEOUT_MS = previous
            }),
        )

        const started = Date.now()
        const error = yield* Git.fetchBare({ repoPath: bare }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Git.GitCommandTimeoutError)
        expect(Date.now() - started).toBeLessThan(10_000)

        // A second writer acquires the lock: no transport descendant still holds it.
        yield* Effect.void.pipe(
          withGitWriterLock({ path: bare }),
          Effect.timeoutOrElse({
            duration: '5 seconds',
            orElse: () => Effect.die('writer lock still held after the stalled fetch'),
          }),
        )
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  )
})
