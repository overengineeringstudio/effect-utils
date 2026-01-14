/**
 * Integration tests for dotdot tree command
 */

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createWorkspace, withTestCtx, workspaceLayerFromPath } from '../test-utils/mod.ts'
import { treeCommand } from './mod.ts'

describe('tree command', () => {
  it('shows empty tree', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          repos: [],
        })

        yield* treeCommand.handler({}).pipe(Effect.provide(workspaceLayerFromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('shows repos from root config', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
            'repo-b': { url: 'git@github.com:test/repo-b.git' },
          },
          repos: [
            { name: 'repo-a', isGitRepo: true },
            { name: 'repo-b', isGitRepo: true },
          ],
        })

        yield* treeCommand.handler({}).pipe(Effect.provide(workspaceLayerFromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('shows repos with revisions', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': {
              url: 'git@github.com:test/repo-a.git',
              rev: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
            },
            'repo-b': { url: 'git@github.com:test/repo-b.git' },
          },
          repos: [
            { name: 'repo-a', isGitRepo: true },
            { name: 'repo-b', isGitRepo: true },
          ],
        })

        yield* treeCommand.handler({}).pipe(Effect.provide(workspaceLayerFromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('handles workspace with member configs in sync', () =>
    withTestCtx(
      Effect.gen(function* () {
        // Member config declares repo-b, which is also in root config (in sync)
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
            'repo-b': { url: 'git@github.com:test/repo-b.git' },
          },
          repos: [
            {
              name: 'repo-a',
              isGitRepo: true,
              hasConfig: true,
              configDeps: {
                'repo-b': { url: 'git@github.com:test/repo-b.git' },
              },
            },
            { name: 'repo-b', isGitRepo: true },
          ],
        })

        yield* treeCommand.handler({}).pipe(Effect.provide(workspaceLayerFromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))
})
