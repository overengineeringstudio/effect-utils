import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { makeStoreLayer, Store } from './store.ts'

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const basePath = EffectPath.unsafe.absoluteDir(`${tmp}/store/`)
  const repoPath = `${basePath}github.com/example/repo`
  yield* fs.makeDirectory(repoPath, { recursive: true })
  yield* Git.runCommand({ cwd: repoPath, args: ['init', '--bare', '.bare'] })
  return { fs, basePath, repoPath }
})

describe('store census symlinks', () => {
  it.effect('listRepos skips dangling node_modules symlinks in non-git directories', () =>
    Effect.gen(function* () {
      const { fs, basePath } = yield* makeFixture
      const scratch = `${basePath}github.com/tmp/scratch`
      yield* fs.makeDirectory(scratch, { recursive: true })
      yield* fs.symlink('../other/node_modules', `${scratch}/node_modules`)
      const repos = yield* Effect.gen(function* () {
        const store = yield* Store
        return yield* store.listRepos
      }).pipe(Effect.provide(makeStoreLayer({ basePath })))
      expect(repos.map((repo) => repo.relativePath)).toEqual(['github.com/example/repo/'])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('listRepos does not count symlinks to real repository directories', () =>
    Effect.gen(function* () {
      const { fs, basePath, repoPath } = yield* makeFixture
      yield* fs.symlink(repoPath, `${basePath}github.com/example/alias`)
      yield* fs.symlink(`${basePath}github.com/example`, `${basePath}github.com/alias`)
      yield* fs.symlink(`${basePath}github.com`, `${basePath}alias.example`)
      const repos = yield* Effect.gen(function* () {
        const store = yield* Store
        return yield* store.listRepos
      }).pipe(Effect.provide(makeStoreLayer({ basePath })))
      expect(repos.map((repo) => repo.relativePath)).toEqual(['github.com/example/repo/'])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
