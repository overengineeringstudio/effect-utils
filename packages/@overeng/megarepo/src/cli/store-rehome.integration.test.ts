import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import * as Cli from 'effect/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { inspectForeignGitDir } from '../store/store-rehome.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  rehomeFixture as fixture,
  snapshotRehome as snapshot,
} from '../test-utils/rehome-fixture.ts'
import { mrCommand } from './mod.ts'

const testEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)
const runStoreCommand = (cwd: AbsoluteDirPath, storePath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.MEGAREPO_STORE
        process.env.MEGAREPO_STORE = storePath
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.MEGAREPO_STORE
          else process.env.MEGAREPO_STORE = previous
        }),
    )
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
      '--cwd',
      cwd,
      'store',
      ...args,
      '--output',
      'json',
    ]).pipe(Effect.provide(Layer.mergeAll(consoleLayer, NodeServices.layer)), Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
    return (yield* getStdoutLines).join('\n')
  }).pipe(Effect.scoped)
it.effect('CLI status and fix repair commits while named branches remain report-only', () =>
  testEffect(
    Effect.gen(function* () {
      const f = yield* fixture()
      const branchPath = EffectPath.unsafe.absoluteDir(
        `${f.bareRepoPath.replace(/\.bare\/$/u, '')}refs/heads/private/`,
      )
      yield* Git.runCommand({
        cwd: f.foreign,
        args: ['worktree', 'add', '-b', 'private', branchPath, f.commit],
      })
      const branchBefore = yield* snapshot(branchPath)
      const treeBefore = yield* snapshot(f.worktreePath)
      const foreignBefore = yield* snapshot(f.foreign)
      const run = (args: ReadonlyArray<string>) =>
        runStoreCommand(f.worktreePath, f.store.storePath, args)
      expect(yield* run(['status'])).toContain('foreign-git-dir')
      expect(yield* run(['fix', '--dry-run'])).toContain('report-only')
      expect(yield* snapshot(f.worktreePath)).toEqual(treeBefore)
      expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
      const applied = yield* run(['fix'])
      expect(applied).toMatch(/"status":\s*"fixed"/u)
      expect(applied).toContain('report-only')
      expect(yield* inspectForeignGitDir(f)).toBeUndefined()
      expect(
        yield* inspectForeignGitDir({
          worktreePath: branchPath,
          bareRepoPath: f.bareRepoPath,
        }),
      ).toBe(yield* f.fs.realPath(f.foreign))
      expect(yield* snapshot(branchPath)).toEqual(branchBefore)
      expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
    }),
  ),
)
