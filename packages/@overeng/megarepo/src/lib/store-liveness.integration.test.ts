import { Command, FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
} from '../test-utils/store-setup.ts'
import {
  collectStoreLiveSet,
  collectWorkspaceLivePaths,
  refreshWorkspaceRegistry,
} from './store-liveness.ts'
import { makeStoreLayer, Store } from './store.ts'

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

const runGitCommand = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    const result = yield* Command.string(command)
    return result.trim()
  })

describe('store-liveness', () => {
  it.effect(
    'collectWorkspaceLivePaths includes store symlink targets',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'symlinked-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/symlinked-repo#main']!
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/symlinked-repo#main' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        const externalTarget = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeDir('external-target/'),
        )

        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.makeDirectory(externalTarget, { recursive: true })
        yield* fs.symlink(
          normalizePath(mainWorktreePath),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('repo')),
        )
        yield* fs.symlink(
          normalizePath(externalTarget),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('local')),
        )

        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        const livePaths = yield* collectWorkspaceLivePaths({ workspaceRoot: workspacePath, store })

        expect(livePaths).toEqual(new Set([normalizePath(mainWorktreePath)]))
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refreshWorkspaceRegistry records locked ref and commit worktree paths',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'locked-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/locked-repo#main']!
        const commit = yield* getWorktreeCommit(mainWorktreePath)
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/locked-repo#main' },
          lockEntries: {
            repo: {
              url: 'git@github.com:test-owner/locked-repo.git',
              ref: 'main',
              commit,
            },
          },
        })
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        const commitWorktreePath = store.getWorktreePath({
          source: {
            type: 'github',
            owner: 'test-owner',
            repo: 'locked-repo',
            ref: Option.some('main'),
          },
          ref: commit,
          refType: 'commit',
        })

        const record = yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store })

        expect(record.workspaceRoot).toBe(normalizePath(workspacePath))
        expect(record.livePaths).toEqual(
          [normalizePath(commitWorktreePath), normalizePath(mainWorktreePath)].sort(),
        )

        const registryDir = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        const registryEntries = yield* fs.readDirectory(registryDir)
        expect(registryEntries).toHaveLength(1)

        const registryContent = yield* fs.readFileString(
          EffectPath.ops.join(registryDir, EffectPath.unsafe.relativeFile(registryEntries[0]!)),
        )
        expect(JSON.parse(registryContent)).toMatchObject({
          version: 1,
          workspaceRoot: normalizePath(workspacePath),
          livePaths: [normalizePath(commitWorktreePath), normalizePath(mainWorktreePath)].sort(),
        })
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'collectStoreLiveSet protects lock-referenced commit worktree paths',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths, bareRepoPaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'commit-live-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/commit-live-repo#main']!
        const commit = yield* getWorktreeCommit(mainWorktreePath)
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        const commitWorktreePath = store.getWorktreePath({
          source: {
            type: 'github',
            owner: 'test-owner',
            repo: 'commit-live-repo',
            ref: Option.some('main'),
          },
          ref: commit,
          refType: 'commit',
        })
        const bareRepoPath = bareRepoPaths['github.com/test-owner/commit-live-repo']!

        yield* fs.makeDirectory(EffectPath.ops.parent(commitWorktreePath)!, { recursive: true })
        yield* runGitCommand(
          bareRepoPath,
          'worktree',
          'add',
          '--detach',
          commitWorktreePath,
          commit,
        )

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/commit-live-repo#main' },
          lockEntries: {
            repo: {
              url: 'git@github.com:test-owner/commit-live-repo.git',
              ref: 'main',
              commit,
            },
          },
        })

        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store })
        const liveSet = yield* collectStoreLiveSet({
          store,
          refreshCurrentWorkspace: false,
        })

        expect(liveSet.paths).toContain(normalizePath(commitWorktreePath))
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})
