import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { expect, vi } from 'vitest'

import * as Git from '../core/git.ts'
import { rehomeFixture } from '../test-utils/rehome-fixture.ts'
import { inspectForeignGitDir, rehomeCommitWorktree } from './store-rehome.ts'

it.effect('cleans refused/interrupted registration and preserves payloads on retry', () =>
  Effect.gen(function* () {
    const f = yield* rehomeFixture(false)
    const payload = yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)
    const foreignControl = yield* f.fs.readFileString(`${f.foreignAdmin}/gitdir`)
    const control = yield* f.fs.readFileString(`${f.worktreePath}.git`)
    yield* f.fs.makeDirectory(`${f.bareRepoPath}worktrees`, { recursive: true })
    const registrations = yield* f.fs.readDirectory(`${f.bareRepoPath}worktrees`)
    const parent = `${f.worktreePath}..`
    const entries = yield* f.fs.readDirectory(parent)
    const run = Git.runCommand
    for (const interrupt of [false, true]) {
      const spy = vi
        .spyOn(Git, 'runCommand')
        .mockImplementation((options) =>
          run(options).pipe(
            Effect.tap(() =>
              interrupt === true && options.args.includes('--no-checkout') === true
                ? Effect.withFiber((fiber) =>
                    Fiber.interrupt(fiber).pipe(Effect.forkDetach({ startImmediately: true })),
                  )
                : interrupt === false && options.args.includes('read-tree') === true
                  ? f.fs
                      .writeFileString(`${f.worktreePath}megarepo.json`, 'dirty')
                      .pipe(Effect.orDie)
                  : Effect.void,
            ),
          ),
        )
      const failed = yield* rehomeCommitWorktree(f).pipe(
        Effect.forkChild,
        Effect.flatMap(Fiber.await),
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      )
      expect(failed._tag).toBe('Failure')
      expect(yield* f.fs.readDirectory(`${f.bareRepoPath}worktrees`)).toEqual(registrations)
      expect(yield* f.fs.readDirectory(parent)).toEqual(entries)
      expect(yield* f.fs.readFileString(`${f.worktreePath}.git`)).toBe(control)
      yield* f.fs.writeFile(`${f.worktreePath}megarepo.json`, payload)
    }
    expect(yield* inspectForeignGitDir(f)).toBe(yield* f.fs.realPath(f.foreign))
    yield* rehomeCommitWorktree(f)
    expect(yield* inspectForeignGitDir(f)).toBeUndefined()
    expect(yield* Git.getCurrentCommit(f.worktreePath)).toBe(f.commit)
    expect(yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)).toEqual(payload)
    expect(yield* f.fs.readFileString(`${f.foreignAdmin}/gitdir`)).toBe(foreignControl)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
