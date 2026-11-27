import { link, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import * as Git from '../core/git.ts'
import {
  advancePoolHeadHistory,
  inspectFreshPoolHeadHistory,
  inspectPoolHeadHistory,
} from './store-pool-head-history.ts'
import { withPoolGlobalEpoch } from './store-pool-lock-order.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })

// Genuine Git objects, linked detached worktrees and reflogs. No fake command/provider/proof.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const bare = join(root, 'repo.git')
  const path = join(root, 'slot')
  const command = (args: ReadonlyArray<string>) => Git.runCommand({ args, cwd: bare })
  yield* Git.runCommand({ args: ['init', '--bare', bare], cwd: root })
  yield* command(['config', 'core.logAllRefUpdates', 'true'])
  const tree = yield* command(['write-tree'])
  const commitObject = (message: string) =>
    command([
      '-c',
      'user.name=Pool Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit-tree',
      tree,
      '-m',
      message,
    ])
  const commit = yield* commitObject('source')
  const other = yield* commitObject('other unpublished fixture object')
  yield* Git.createWorktreeDetached({ repoPath: bare, worktreePath: path, commit })
  const admin = yield* Git.getAbsoluteGitDir(path)
  const target = { path, admin, commit }
  const log = join(admin, 'logs', 'HEAD')
  const checkout = (next: string) =>
    Git.runCommand({ args: ['checkout', '--detach', next], cwd: path })
  return { fs, target, other, log, checkout, command }
})

const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(effect))).toBe(true)
  })

describe('pool HEAD history binding', () => {
  it.effect(
    'accepts a fresh native log, preserves unchanged identity and verifies owned same-commit checkout',
    (test) =>
      Effect.gen(function* () {
        const { target, checkout } = yield* fixture
        const before = yield* inspectFreshPoolHeadHistory(target)
        expect(before.commit).toBe(target.commit)
        expect(before.byteLength).toBeGreaterThan(0)
        expect(before.digest).toMatch(/^[0-9a-f]{64}$/u)
        expect(yield* inspectPoolHeadHistory(target)).toEqual(before)
        yield* checkout(target.commit)
        const after = yield* advancePoolHeadHistory({ ...target, previous: before })
        expect(after).toEqual(yield* inspectFreshPoolHeadHistory(target))
      }).pipe(withTestCtx(test)),
  )

  it.effect(
    'accepts only the expected owned old-to-new checkout after the exact retained prefix',
    (test) =>
      Effect.gen(function* () {
        const { target, other, checkout } = yield* fixture
        const previous = yield* inspectFreshPoolHeadHistory(target)
        yield* checkout(other)
        const next = { ...target, commit: other }
        const after = yield* advancePoolHeadHistory({ ...next, previous })
        expect(after.commit).toBe(other)
        expect(after.byteLength).toBeGreaterThan(previous.byteLength)
        expect(after).toEqual(yield* inspectPoolHeadHistory(next))
        yield* refused(inspectFreshPoolHeadHistory(next))
      }).pipe(withTestCtx(test)),
  )

  it.effect(
    'refuses authored commit then reset even when HEAD and tracked source are restored',
    (test) =>
      Effect.gen(function* () {
        const { target, other, checkout } = yield* fixture
        const previous = yield* inspectFreshPoolHeadHistory(target)
        yield* Git.runCommand({ args: ['update-ref', 'HEAD', other], cwd: target.path })
        yield* checkout(target.commit)
        expect(yield* Git.getCurrentCommit(target.path)).toBe(target.commit)
        expect((yield* inspectPoolHeadHistory(target)).digest).not.toBe(previous.digest)
        yield* refused(inspectFreshPoolHeadHistory(target))
        yield* refused(advancePoolHeadHistory({ ...target, previous }))
      }).pipe(withTestCtx(test)),
  )

  it.effect('checks raw OLD hashes after expiry, not just reflog NEW values', (test) =>
    Effect.gen(function* () {
      const { target, other, checkout } = yield* fixture
      yield* Git.runCommand({ args: ['update-ref', 'HEAD', other], cwd: target.path })
      yield* Git.runCommand({
        args: ['reflog', 'expire', '--expire=now', 'HEAD'],
        cwd: target.path,
      })
      yield* checkout(target.commit)
      expect(yield* Git.getCurrentCommit(target.path)).toBe(target.commit)
      yield* refused(inspectFreshPoolHeadHistory(target))
    }).pipe(withTestCtx(test)),
  )

  it.effect(
    'refuses prefix rewriting even when a subsequent checkout transition is expected',
    (test) =>
      Effect.gen(function* () {
        const { fs, target, other, checkout, log } = yield* fixture
        const previous = yield* inspectFreshPoolHeadHistory(target)
        const changed = Buffer.from(yield* fs.readFile(log))
        changed.writeUInt8(changed.readUInt8(changed.length - 2) ^ 1, changed.length - 2)
        yield* fs.writeFile(log, changed)
        yield* checkout(other)
        yield* refused(advancePoolHeadHistory({ ...target, commit: other, previous }))
      }).pipe(withTestCtx(test)),
  )

  for (const kind of ['disabled', 'missing', 'empty', 'symlink', 'hardlink'] as const) {
    it.effect(`refuses ${kind} logging without repairing or accepting the root`, (test) =>
      Effect.gen(function* () {
        const { fs, target, log, command } = yield* fixture
        const outside = join(target.admin, 'outside-test-log')
        const original = yield* fs.readFile(log)
        if (kind === 'disabled') yield* command(['config', 'core.logAllRefUpdates', 'false'])
        else if (kind === 'missing') yield* fs.remove(log)
        else if (kind === 'empty') yield* fs.writeFile(log, new Uint8Array())
        else if (kind === 'symlink') {
          yield* fs.writeFile(outside, original)
          yield* fs.remove(log)
          yield* Effect.promise(() => symlink(outside, log))
        } else yield* Effect.promise(() => link(log, outside))
        yield* refused(inspectFreshPoolHeadHistory(target))
        if (kind === 'missing') expect(yield* fs.exists(log)).toBe(false)
        if (kind === 'empty') expect((yield* fs.readFile(log)).length).toBe(0)
        if (kind === 'disabled')
          expect(yield* command(['config', '--get', 'core.logAllRefUpdates'])).toBe('false')
        if (kind === 'symlink' || kind === 'hardlink')
          expect(yield* fs.readFile(outside)).toEqual(original)
      }).pipe(withTestCtx(test)),
    )
  }

  it.effect('refuses a reverse GLOBAL history read before any Git or filesystem access', (test) =>
    Effect.gen(function* () {
      const error = yield* inspectPoolHeadHistory({
        path: '/nonexistent-pool-history-fixture',
        admin: '/nonexistent-pool-history-fixture-admin',
        commit: 'a'.repeat(40),
      }).pipe(withPoolGlobalEpoch, Effect.flip)
      expect(error._tag).toBe('PoolError')
      expect(error.message).toBe('Pool HEAD history cannot be proved; HOLD')
    }).pipe(withTestCtx(test)),
  )
})
