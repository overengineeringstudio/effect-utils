import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { createBareRepo, createRepo, runGitCommand } from './setup.ts'
import { makeCanonicalTempDirectoryScoped } from './temp-root.ts'

const repositoryEnvironmentKeys = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
] as const

describe('git fixture environment isolation', () => {
  it.effect(
    'initializes independent repositories without changing inherited repository state or environment',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const basePath = EffectPath.unsafe.absoluteDir(
          `${yield* makeCanonicalTempDirectoryScoped()}/`,
        )
        const inheritedRepo = yield* createRepo({ basePath, fixture: { name: 'inherited' } })
        const inheritedGitDir = `${inheritedRepo}.git`
        const configPath = `${inheritedGitDir}/config`
        const indexPath = `${inheritedGitDir}/index`
        const originalConfig = yield* fs.readFileString(configPath)
        const originalIndex = yield* fs.readFile(indexPath)
        const previous = new Map(repositoryEnvironmentKeys.map((key) => [key, process.env[key]]))
        const polluted = {
          GIT_DIR: inheritedGitDir,
          GIT_COMMON_DIR: inheritedGitDir,
          GIT_WORK_TREE: inheritedRepo,
          GIT_INDEX_FILE: indexPath,
        }

        yield* Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              for (const key of repositoryEnvironmentKeys) process.env[key] = polluted[key]
            }),
            () =>
              Effect.sync(() => {
                for (const [key, value] of previous) {
                  if (value === undefined) delete process.env[key]
                  else process.env[key] = value
                }
              }),
          )

          const repo = yield* createRepo({ basePath, fixture: { name: 'isolated' } })
          const bareRepo = yield* createBareRepo('isolated-bare')
          expect(yield* runGitCommand(repo, 'rev-parse', '--show-toplevel')).toBe(
            repo.replace(/\/+$/, ''),
          )
          expect(yield* runGitCommand(repo, 'log', '-1', '--format=%s')).toBe('Initial commit')
          expect(yield* runGitCommand(bareRepo, 'rev-parse', '--is-bare-repository')).toBe('true')
          expect(yield* fs.exists(`${repo}.git/config`)).toBe(true)
          expect(yield* fs.exists(`${bareRepo}config`)).toBe(true)
          expect(yield* fs.readFileString(configPath)).toBe(originalConfig)
          expect(yield* fs.readFile(indexPath)).toEqual(originalIndex)
          expect(yield* runGitCommand(inheritedRepo, 'status', '--porcelain')).toBe('')
          for (const key of repositoryEnvironmentKeys) {
            expect(process.env[key]).toBe(polluted[key])
          }
        }).pipe(Effect.scoped)

        for (const [key, value] of previous) expect(process.env[key]).toBe(value)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
