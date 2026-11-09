import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import {
  signalLockHoldingProcessGroup,
  startGitWriterProcess,
  withGitContainerLock,
  withGitWriterLock,
} from './git-writer-lock.ts'

const worker = fileURLToPath(new URL('../test-utils/git-writer-lock-worker.ts', import.meta.url))
const cli = fileURLToPath(new URL('../../bin/mr.ts', import.meta.url))
const bun = process.env.BUN_BIN ?? (process.versions.bun === undefined ? 'bun' : process.execPath)

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return (yield* spawner.string(ChildProcess.make('git', args, { cwd }))).trim()
  })

/** Local deadlines make broken workers fail instead of hanging a suite. */
const awaitMarker = Effect.fn('test/writer-lock/awaitMarker')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  while ((yield* fs.exists(path)) === false) {
    yield* Effect.sleep('10 millis')
  }
}, Effect.timeout('60 seconds'))

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const source = `${root}/source`
  const bare = `${root}/repo.bare`
  const worktree = `${root}/worktree`
  yield* fs.makeDirectory(source)
  yield* git(source, 'init', '-b', 'main')
  yield* git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '--no-verify',
    '-m',
    'initial',
  )
  yield* git(root, 'clone', '--bare', source, bare)
  yield* git(bare, 'worktree', 'add', '--detach', worktree, 'HEAD')
  const common = yield* fs.realPath(bare)
  return { fs, root, source, bare, worktree, common }
})

const startWorker = Effect.fn('test/writer-lock/startWorker')(function* (
  repo: string,
  marker: string,
  mode: 'primitive' | 'clone' | 'cli' = 'primitive',
  exitCode = 0,
  extraArgs: ReadonlyArray<string> = [],
  cloneTarget = false,
) {
  const fs = yield* FileSystem.FileSystem
  // Also release orphaned CLI payloads if a test assertion fails.
  yield* Effect.addFinalizer(() => fs.writeFileString(`${marker}.release`, '').pipe(Effect.orDie))
  return yield* ChildProcess.make(
    bun,
    mode === 'cli'
      ? [
          cli,
          'store',
          'lock',
          ...(cloneTarget === true ? ['--clone-target'] : []),
          repo,
          '--',
          bun,
          worker,
          'payload',
          repo,
          marker,
          String(exitCode),
          ...extraArgs,
        ]
      : [worker, mode, repo, marker, String(exitCode), ...extraArgs],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
  )
})

const expectBlocked = Effect.fn('test/writer-lock/expectBlocked')(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem
  yield* awaitMarker(`${marker}.attempted`)
  // A negative concurrency assertion needs a bounded observation window. Positive
  // handshakes before and after ensure the contender actually runs and completes.
  yield* Effect.sleep('250 millis')
  expect(yield* fs.exists(`${marker}.entered`)).toBe(false)
})

describe('Git common-directory writer lock (Bun subprocesses)', { timeout: 120_000 }, () => {
  it.live('shared container holders coexist and veto exclusive reclamation', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const shared = withGitContainerLock({ path: f.bare, mode: 'shared' })
      const exclusive = withGitContainerLock({ path: f.bare, mode: 'exclusive' })
      const blocked = yield* exclusive(Effect.void).pipe(Effect.result, shared, shared)
      expect(blocked._tag).toBe('Failure')
      yield* exclusive(Effect.void)
      expect(
        (yield* withGitContainerLock({ path: `${f.root}/missing`, mode: 'shared' })(
          Effect.void,
        ).pipe(Effect.result))._tag,
      ).toBe('Failure')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
  it.live('passes lazy-fetch suppression to the native locked writer process', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const output = yield* Effect.gen(function* () {
        const child = yield* startGitWriterProcess({
          command: bun,
          args: ['-e', 'process.stdout.write(process.env.GIT_NO_LAZY_FETCH ?? "unset")'],
          env: { GIT_NO_LAZY_FETCH: '1' },
        })
        const chunks = yield* Stream.runCollect(child.stdout)
        expect(yield* child.exitCode).toBe(0)
        return Buffer.concat(chunks).toString()
      }).pipe(withGitWriterLock({ path: f.bare }))
      expect(output).toBe('1')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('serializes primitive and external CLI writers across bare/worktree/symlink paths', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const alias = `${f.root}/alias`
      yield* f.fs.symlink(f.worktree, alias)
      const first = `${f.root}/first`
      const second = `${f.root}/second`
      const third = `${f.root}/third`
      const holder = yield* startWorker(f.bare, first, 'cli')
      yield* awaitMarker(`${first}.entered`)
      const external = yield* startWorker(alias, second)
      const contender = yield* startWorker(f.worktree, third)
      yield* expectBlocked(third)
      yield* expectBlocked(second)
      yield* f.fs.writeFileString(`${first}.release`, '')
      expect(yield* holder.exitCode).toBe(0)
      // Either waiter may win. Release both, then require both to have entered.
      yield* f.fs.writeFileString(`${second}.release`, '')
      yield* f.fs.writeFileString(`${third}.release`, '')
      expect(yield* external.exitCode).toBe(0)
      expect(yield* contender.exitCode).toBe(0)
      expect(yield* f.fs.exists(`${second}.entered`)).toBe(true)
      expect(yield* f.fs.exists(`${third}.entered`)).toBe(true)
      expect(yield* f.fs.exists(`${f.common}.mr-writer.lock`)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('uses the same identity before, during, and after a bare clone', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const target = `${f.root}/new.bare`
      const first = `${f.root}/first`
      const second = `${f.root}/second`
      const holder = yield* startWorker(target, first, 'cli', 0, [], true)
      yield* awaitMarker(`${first}.entered`)
      // A second clone must wait even while the first has created an incomplete directory.
      yield* f.fs.makeDirectory(target)
      const contender = yield* startWorker(target, second, 'clone')
      yield* expectBlocked(second)
      yield* git(f.root, 'clone', '--bare', f.source, target)
      yield* f.fs.writeFileString(`${first}.release`, '')
      expect(yield* holder.exitCode).toBe(0)
      yield* awaitMarker(`${second}.entered`)
      yield* f.fs.writeFileString(`${second}.release`, '')
      expect(yield* contender.exitCode).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('allows distinct common directories to hold locks concurrently', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const other = `${f.root}/other.bare`
      yield* git(f.root, 'clone', '--bare', f.source, other)
      const first = `${f.root}/first`
      const second = `${f.root}/second`
      const holder = yield* startWorker(f.bare, first)
      yield* awaitMarker(`${first}.entered`)
      const parallel = yield* startWorker(other, second, 'cli')
      yield* awaitMarker(`${second}.entered`)
      expect(yield* f.fs.exists(`${first}.exited`)).toBe(false)
      yield* f.fs.writeFileString(`${first}.release`, '')
      yield* f.fs.writeFileString(`${second}.release`, '')
      expect(yield* holder.exitCode).toBe(0)
      expect(yield* parallel.exitCode).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('releases a killed holder without deleting the persistent lock file', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const first = `${f.root}/first`
      const second = `${f.root}/second`
      const holder = yield* startWorker(f.worktree, first)
      yield* awaitMarker(`${first}.entered`)
      const before = yield* f.fs.stat(`${f.common}.mr-writer.lock`)
      const contender = yield* startWorker(f.bare, second)
      yield* expectBlocked(second)
      yield* Effect.sync(() => process.kill(holder.pid, 'SIGKILL'))
      yield* holder.exitCode.pipe(Effect.ignore) // Signal termination is an expected spawner error.
      yield* awaitMarker(`${second}.entered`)
      const after = yield* f.fs.stat(`${f.common}.mr-writer.lock`)
      expect(after.ino).toEqual(before.ino)
      yield* f.fs.writeFileString(`${second}.release`, '')
      expect(yield* contender.exitCode).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('keeps a surviving Git writer locked after its mr wrapper is killed', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const first = `${f.root}/first`
      const second = `${f.root}/second`
      const hook = `${f.bare}/hooks/reference-transaction`
      yield* f.fs.writeFileString(
        hook,
        [
          '#!/bin/sh',
          'if [ "$1" = prepared ]; then',
          '  : > "$MR_LOCK_TEST_MARKER.entered"',
          '  while [ ! -f "$MR_LOCK_TEST_MARKER.release" ]; do sleep 0.01; done',
          'fi',
        ].join('\n'),
      )
      yield* f.fs.chmod(hook, 0o755)
      const commit = yield* git(f.bare, 'rev-parse', 'HEAD')
      yield* Effect.addFinalizer(() =>
        f.fs.writeFileString(`${first}.release`, '').pipe(Effect.orDie),
      )
      const wrapper = yield* ChildProcess.make(
        bun,
        [
          cli,
          'store',
          'lock',
          f.bare,
          '--',
          'git',
          '-C',
          f.bare,
          'update-ref',
          'refs/heads/locked-child',
          commit,
        ],
        {
          env: { MR_LOCK_TEST_MARKER: first },
          extendEnv: true,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'inherit',
        },
      )
      yield* awaitMarker(`${first}.entered`)
      yield* Effect.sync(() => process.kill(wrapper.pid, 'SIGKILL'))
      yield* wrapper.exitCode.pipe(Effect.ignore) // Only the wrapper dies; Git retains the lock.
      const contender = yield* startWorker(f.worktree, second)
      yield* expectBlocked(second)
      yield* f.fs.writeFileString(`${first}.release`, '')
      yield* awaitMarker(`${second}.entered`)
      expect(yield* git(f.bare, 'rev-parse', 'refs/heads/locked-child')).toBe(commit)
      yield* f.fs.writeFileString(`${second}.release`, '')
      expect(yield* contender.exitCode).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('propagates external command exit status and preserves arguments after --', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const marker = `${f.root}/exit with spaces`
      yield* f.fs.writeFileString(`${marker}.release`, '')
      const command = yield* startWorker(f.bare, marker, 'cli', 42, [
        '--literal-flag',
        'two words',
        '--',
      ])
      expect(yield* command.exitCode).toBe(42)
      expect(yield* f.fs.exists(`${marker}.entered`)).toBe(true)
      expect(yield* f.fs.readFileString(`${marker}.args`)).toBe('--literal-flag\ntwo words\n--')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('isolates read-only fetch evidence from canonical refs and shared FETCH_HEAD', () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* git(f.bare, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      yield* git(f.bare, 'fetch', 'origin')
      const original = yield* git(f.bare, 'rev-parse', 'refs/remotes/origin/main')
      const remoteRefs = yield* git(
        f.bare,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/remotes/',
      )
      const fetchHead = yield* f.fs.readFileString(`${f.common}/FETCH_HEAD`)
      yield* git(
        f.source,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '--no-gpg-sign',
        '--no-verify',
        '-m',
        'advance',
      )
      const privateRepo = `${f.root}/evidence.git`
      yield* git(f.root, 'init', '--bare', privateRepo)
      yield* git(
        privateRepo,
        'fetch',
        '--refmap=',
        '--no-write-fetch-head',
        f.source,
        'refs/heads/main:refs/evidence/main',
      )
      const evidence = yield* git(privateRepo, 'rev-parse', 'refs/evidence/main^{commit}')
      expect(evidence).not.toBe(original)
      yield* Git.runCommand({
        cwd: privateRepo,
        args: ['merge-base', '--is-ancestor', original, evidence],
      })
      expect(yield* Git.getCurrentCommit(EffectPath.unsafe.absoluteDir(`${f.worktree}/`))).toBe(
        original,
      )
      expect(yield* git(f.bare, 'rev-parse', 'refs/remotes/origin/main')).toBe(original)
      expect(
        yield* git(f.bare, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'),
      ).toBe(remoteRefs)
      expect(yield* f.fs.readFileString(`${f.common}/FETCH_HEAD`)).toBe(fetchHead)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  for (const scenario of ['empty', 'different-group', 'different-inode', 'lock-holder'] as const) {
    it.effect(`post-exit group signal requires admission inode proof: ${scenario}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const procRoot = `${root}/proc`
        const admission = `${root}/admission`
        const other = `${root}/other`
        yield* fs.makeDirectory(procRoot)
        yield* fs.writeFileString(admission, '')
        yield* fs.writeFileString(other, '')
        const lockIdentity = yield* Effect.promise(() => stat(admission))
        if (scenario !== 'empty') {
          yield* fs.makeDirectory(`${procRoot}/456/fd`, { recursive: true })
          const pgid = scenario === 'different-group' ? 999 : 123
          yield* fs.writeFileString(`${procRoot}/456/stat`, `456 (fixture) S 1 ${pgid} 123 0 0\n`)
          yield* fs.symlink(
            scenario === 'different-inode' ? other : admission,
            `${procRoot}/456/fd/3`,
          )
        }
        const signals: Array<number> = []
        const signalled = yield* Effect.promise(() =>
          signalLockHoldingProcessGroup({
            pgid: 123,
            lockIdentity,
            procRoot,
            kill: (group) => {
              signals.push(group)
            },
          }),
        )
        expect(signalled).toBe(scenario === 'lock-holder')
        expect(signals).toEqual(scenario === 'lock-holder' ? [123] : [])
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }
})
