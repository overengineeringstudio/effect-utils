import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { rehomeFixture } from '../test-utils/rehome-fixture.ts'
import { inspectForeignGitDir, rehomeCommitWorktree } from './store-rehome.ts'

it.effect('re-homes a foreign commit tree without changing its files or foreign registration', () =>
  Effect.gen(function* () {
    const f = yield* rehomeFixture(false)
    const payload = yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)
    const foreignControl = yield* f.fs.readFileString(`${f.foreignAdmin}/gitdir`)
    expect(yield* inspectForeignGitDir(f)).toBe(yield* f.fs.realPath(f.foreign))
    yield* rehomeCommitWorktree(f)
    expect(yield* inspectForeignGitDir(f)).toBeUndefined()
    expect(yield* Git.getCurrentCommit(f.worktreePath)).toBe(f.commit)
    expect(yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)).toEqual(payload)
    expect(yield* f.fs.readFileString(`${f.foreignAdmin}/gitdir`)).toBe(foreignControl)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
