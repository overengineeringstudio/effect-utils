import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { startGitWriterProcess, withGitWriterLock } from './git-writer-lock.ts'

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
        const { upstream, bare, commitB } = yield* fixture

        yield* Git.fetchBare({ repoPath: bare, refs: ['main'] })

        expect(yield* git(bare, 'rev-parse', 'refs/remotes/origin/main')).toBe(commitB)
        expect(yield* tagCount(bare)).toBe(0)
        yield* git(upstream, 'update-ref', 'refs/pull/1/head', commitB)
        yield* Git.fetchPullRequestHeads({ repoPath: bare })
        expect(yield* git(bare, 'rev-parse', 'refs/remotes/origin/pr/1')).toBe(commitB)
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

  it.effect('qualified tag pins refresh exactly the named tag', () =>
    Effect.gen(function* () {
      const { upstream, bare, commitB } = yield* fixture
      yield* Git.fetchBare({ repoPath: bare, refs: ['refs/tags/edge'] })
      yield* git(upstream, 'update-ref', 'refs/tags/edge', commitB)
      yield* Git.fetchBare({ repoPath: bare, refs: ['refs/tags/edge', 'absent'] })
      expect(yield* git(bare, 'rev-parse', 'refs/tags/edge')).toBe(commitB)
      expect(yield* tagCount(bare)).toBe(1)
      expect(yield* Git.refExists({ repoPath: bare, ref: 'refs/tags/refs/tags/edge' })).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('bare ref pins prefer a moved tag over a same-named known branch', () =>
    Effect.gen(function* () {
      const { upstream, bare, commitA, commitB } = yield* fixture
      yield* git(upstream, 'update-ref', 'refs/heads/edge', commitA)
      yield* Git.fetchBare({ repoPath: bare, refs: ['edge'] })
      yield* git(upstream, 'update-ref', 'refs/tags/edge', commitB)
      yield* Git.fetchBare({ repoPath: bare, refs: ['edge'] })
      expect(yield* git(bare, 'rev-parse', 'refs/remotes/origin/edge')).toBe(commitA)
      const resolved = yield* Git.queryLocalRefType({ repoPath: bare, ref: 'edge' })
      expect(resolved.type).toBe('tag')
      expect(yield* git(bare, 'rev-parse', 'refs/tags/edge')).toBe(commitB)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('missing SHA pins fetch objects reachable only from an unrequested tag', () =>
    Effect.gen(function* () {
      const { upstream, bare } = yield* fixture
      const tree = yield* git(upstream, 'rev-parse', 'main^{tree}')
      const tagOnly = yield* git(upstream, 'commit-tree', tree, '-m', 'tag-only root')
      yield* git(upstream, 'update-ref', 'refs/tags/isolated', tagOnly)
      yield* Git.fetchBare({ repoPath: bare })
      expect(yield* Git.refExists({ repoPath: bare, ref: tagOnly })).toBe(false)
      yield* Git.fetchBare({ repoPath: bare, refs: [tagOnly] })
      expect(yield* Git.refExists({ repoPath: bare, ref: tagOnly })).toBe(true)
      expect(yield* tagCount(bare)).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect.skipIf(process.platform !== 'linux')(
    'the admission descriptor is close-on-exec before explicit writer duplication',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { bare } = yield* fixture
        const common = yield* fs.realPath(bare)
        yield* Effect.sync(() => {
          const owned = readdirSync('/proc/self/fd').filter((fd) => {
            try {
              return readlinkSync(`/proc/self/fd/${fd}`) === `${common}.mr-writer.lock`
            } catch {
              return false
            }
          })
          expect(owned).toHaveLength(1)
          const info = readFileSync(`/proc/self/fdinfo/${owned[0]!}`, 'utf8')
          const flags = Number.parseInt(info.match(/^flags:\s+([0-7]+)$/mu)![1]!, 8)
          expect(flags & 0o2000000).toBe(0o2000000)
        }).pipe(withGitWriterLock({ path: bare }))
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.live.skipIf(process.platform !== 'linux')(
    'interrupt kills a lock-holding SIGTERM-resistant grandchild after the leader exits',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { root, bare } = yield* fixture
        const marker = `${root}/grandchild-pid`
        const bun = process.versions.bun === undefined ? 'bun' : process.execPath
        // These subprocess timers keep real OS processes alive; fake clocks cannot
        // exercise process-group signals or kernel flock descriptor ownership.
        const grandchild = `
          process.on('SIGTERM', () => {});
          require('node:fs').writeFileSync(process.argv[1], String(process.pid));
          setInterval(() => {}, 1000);
        `
        const leader = `
          require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {
            stdio: ['ignore', 'ignore', 'ignore', 3]
          });
          setInterval(() => {}, 1000);
        `
        // Cleanup only this fixture process even if a regression leaves it alive.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              const pid = Number(readFileSync(marker, 'utf8'))
              process.kill(pid, 'SIGKILL')
            } catch {
              // No marker, or the fixture process has already exited.
            }
          }),
        )
        const result = yield* Effect.gen(function* () {
          yield* startGitWriterProcess({ command: bun, args: ['-e', leader, grandchild, marker] })
          while ((yield* fs.exists(marker)) === false) yield* Effect.sleep('10 millis')
          return yield* Effect.never
        }).pipe(
          Effect.scoped,
          withGitWriterLock({ path: bare }),
          Effect.timeout('1500 millis'),
          Effect.result,
        )
        expect(result._tag).toBe('Failure')
        expect(yield* fs.exists(marker)).toBe(true)
        yield* Effect.void.pipe(withGitWriterLock({ path: bare }), Effect.timeout('5 seconds'))
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
