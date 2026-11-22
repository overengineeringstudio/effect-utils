import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { makeStoreLayer, Store } from './store.ts'

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const basePath = EffectPath.unsafe.absoluteDir(`${tmp}/store/`)
  const repoPath = `${basePath}github.com/example/repo`
  yield* fs.makeDirectory(`${repoPath}/.bare`, { recursive: true })
  return { fs, basePath, repoPath }
})

describe('store census symlinks', () => {
  it.effect('listRepos skips dangling node_modules symlinks in non-git directories', () =>
    Effect.gen(function* () {
      const { fs, basePath } = yield* makeFixture
      const scratch = `${basePath}github.com/tmp/scratch`
      yield* fs.makeDirectory(scratch, { recursive: true })
      yield* fs.symlink('../other/node_modules', `${scratch}/node_modules`)
      const { repos, complete, unaccounted } = yield* Effect.gen(function* () {
        const store = yield* Store
        return yield* store.listRepos
      }).pipe(Effect.provide(makeStoreLayer({ basePath })))
      expect(repos.map((repo) => repo.relativePath)).toEqual(['github.com/example/repo/'])
      expect(complete).toBe(true)
      expect(unaccounted).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('listRepos does not count symlinks to real repository directories', () =>
    Effect.gen(function* () {
      const { fs, basePath, repoPath } = yield* makeFixture
      yield* fs.symlink(repoPath, `${basePath}github.com/example/alias`)
      yield* fs.symlink(`${basePath}github.com/example`, `${basePath}github.com/alias`)
      yield* fs.symlink(`${basePath}github.com`, `${basePath}alias.example`)
      const { repos, complete, unaccounted } = yield* Effect.gen(function* () {
        const store = yield* Store
        return yield* store.listRepos
      }).pipe(Effect.provide(makeStoreLayer({ basePath })))
      expect(repos.map((repo) => repo.relativePath)).toEqual(['github.com/example/repo/'])
      expect(complete).toBe(true)
      expect(unaccounted).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('resolves store aliases for repository paths and unaccounted boundaries', () =>
    Effect.gen(function* () {
      const { fs, basePath, repoPath } = yield* makeFixture
      const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/')
      yield* fs.makeDirectory(`${basePath}github.com/unknown/${deep}`, { recursive: true })
      const alias = EffectPath.unsafe.absoluteDir(`${basePath.replace(/\/$/, '')}-alias/`)
      yield* fs.symlink(basePath, alias.replace(/\/$/, ''))
      const census = yield* Effect.gen(function* () {
        const store = yield* Store
        return yield* store.listRepos
      }).pipe(Effect.provide(makeStoreLayer({ basePath: alias })))
      expect(census.complete).toBe(false)
      expect(census.complete).toBe(census.unaccounted.length === 0)
      expect(census.repos[0]?.fullPath).toBe(`${yield* fs.realPath(repoPath)}/`)
      expect(census.unaccounted).toHaveLength(1)
      for (const entry of census.unaccounted) {
        expect(entry.path).toBe(yield* fs.realPath(entry.path))
        expect(entry.path.startsWith(basePath)).toBe(true)
        expect(entry.path.startsWith(alias)).toBe(false)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
