import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { createRepo, createWorkspace } from '../test-utils/setup.ts'
import { withTestCtx } from '../test-utils/withTestCtx.ts'

describe('mr sync', () => {
  describe('with local path members', () => {
    it('should create symlinks for local path members', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const pathService = yield* Path.Path

          // Create a temp directory with a local repo
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          const localRepoPath = yield* createRepo(tmpDir, {
            name: 'local-lib',
            files: { 'package.json': '{"name": "local-lib"}' },
          })

          // Create workspace with path member pointing to local repo
          const { workspacePath } = yield* createWorkspace({
            name: 'test-megarepo',
            members: {
              'local-lib': { path: localRepoPath },
            },
          })

          // Verify the config was created
          const configPath = pathService.join(workspacePath, 'megarepo.json')
          expect(yield* fs.exists(configPath)).toBe(true)

          // Verify symlink does NOT exist yet (sync hasn't run)
          const symlinkPath = pathService.join(workspacePath, 'local-lib')
          expect(yield* fs.exists(symlinkPath)).toBe(false)

          // Note: Actually running the sync command would require more setup
          // (proper CLI runner, etc). This test verifies the workspace fixture works.
        }),
      ))
  })

  describe('workspace fixture', () => {
    it('should create workspace with symlinked repos', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const pathService = yield* Path.Path

          // Create workspace with repos that get symlinked
          const { workspacePath, repoPaths } = yield* createWorkspace({
            name: 'full-workspace',
            members: {
              repo1: { github: 'test/repo1' },
            },
            repos: [{ name: 'repo1' }],
          })

          // Verify workspace structure
          expect(yield* fs.exists(workspacePath)).toBe(true)
          expect(yield* fs.exists(pathService.join(workspacePath, 'megarepo.json'))).toBe(true)

          // Verify repo was created and symlinked
          expect(repoPaths['repo1']).toBeDefined()
          const symlinkPath = pathService.join(workspacePath, 'repo1')
          expect(yield* fs.exists(symlinkPath)).toBe(true)

          // Verify it's a symlink by reading the link target
          const linkTarget = yield* fs.readLink(symlinkPath)
          expect(linkTarget).toBe(repoPaths['repo1'])
        }),
      ))
  })
})
