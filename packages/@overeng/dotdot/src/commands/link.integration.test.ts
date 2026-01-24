/**
 * Integration tests for symlink management functions
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  createPackageTarget,
  createWorkspace,
  generateRootConfig,
  withTestCtx,
} from '../test-utils/mod.ts'
import { pruneStaleSymlinks, syncSymlinks } from './link.ts'

describe('symlink management', () => {
  describe('syncSymlinks', () => {
    it('creates symlinks from packages config', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          // Create package target
          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          // Update config with packages
          yield* fs.writeFileString(
            `${workspacePath}/dotdot-root.json`,
            generateRootConfig({
              repos: { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
              packages: {
                'shared-lib': { repo: 'repo-a', path: 'shared-lib' },
              },
            }),
          )

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
            dryRun: false,
            force: false,
          })

          expect(result.created).toContain('shared-lib')

          // Check symlink was created
          const symlinkPath = `${workspacePath}/shared-lib`
          const exists = yield* fs.exists(symlinkPath)
          expect(exists).toBe(true)

          // Check symlink target is correct (readLink fails if not a symlink)
          const linkTarget = yield* fs.readLink(symlinkPath)
          expect(linkTarget).toBe('repo-a/shared-lib')
        }),
      ))

    it('dry run does not create symlinks', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
            dryRun: true,
            force: false,
          })

          expect(result.created).toContain('shared-lib')

          // Check symlink was NOT created
          const exists = yield* fs.exists(`${workspacePath}/shared-lib`)
          expect(exists).toBe(false)
        }),
      ))

    it('creates symlinks for packages with different names', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [
              { name: 'repo-a', isGitRepo: true },
              { name: 'repo-b', isGitRepo: true },
            ],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })
          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-b`,
            packagePath: 'shared-lib',
          })

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: {
              'shared-lib-a': { repo: 'repo-a', path: 'shared-lib' },
              'shared-lib-b': { repo: 'repo-b', path: 'shared-lib' },
            },
            dryRun: false,
            force: false,
          })

          expect(result.created).toContain('shared-lib-a')
          expect(result.created).toContain('shared-lib-b')

          // Both symlinks should be created
          expect(yield* fs.exists(`${workspacePath}/shared-lib-a`)).toBe(true)
          expect(yield* fs.exists(`${workspacePath}/shared-lib-b`)).toBe(true)
        }),
      ))

    it('force overwrites existing symlinks', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          // Create an existing file where the symlink should go
          const symlinkPath = `${workspacePath}/shared-lib`
          yield* fs.writeFileString(symlinkPath, 'existing file')

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
            dryRun: false,
            force: true,
          })

          expect(result.overwritten).toContain('shared-lib')

          // Check symlink was created (force overwrote the file)
          // readLink fails if not a symlink, so this verifies it was created correctly
          const linkTarget = yield* fs.readLink(symlinkPath)
          expect(linkTarget).toBe('repo-a/shared-lib')
        }),
      ))

    it('skips when source does not exist', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          // Don't create the package target

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { nonexistent: { repo: 'repo-a', path: 'nonexistent' } },
            dryRun: false,
            force: false,
          })

          expect(result.skipped).toContain('nonexistent')

          // Check symlink was NOT created
          expect(yield* fs.exists(`${workspacePath}/nonexistent`)).toBe(false)
        }),
      ))

    it('handles empty packages config', () =>
      withTestCtx(
        Effect.gen(function* () {
          const workspacePath = yield* createWorkspace({
            repos: [],
          })

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: {},
            dryRun: false,
            force: false,
          })

          expect(result.created).toHaveLength(0)
          expect(result.skipped).toHaveLength(0)
        }),
      ))

    it('supports different package name than path', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          // Create package at nested path
          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'packages/utils',
          })

          const result = yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: {
              '@org/utils': { repo: 'repo-a', path: 'packages/utils' },
            },
            dryRun: false,
            force: false,
          })

          expect(result.created).toContain('@org/utils')

          // Check symlink was created with package name (readLink verifies it's a symlink)
          const symlinkPath = `${workspacePath}/@org/utils`
          const linkTarget = yield* fs.readLink(symlinkPath)
          expect(linkTarget).toBe('../repo-a/packages/utils')
        }),
      ))
  })

  describe('pruneStaleSymlinks', () => {
    it('removes stale symlinks', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          // Create a symlink
          yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
            dryRun: false,
            force: false,
          })

          expect(yield* fs.exists(`${workspacePath}/shared-lib`)).toBe(true)

          // Prune with empty packages (so symlink becomes stale)
          const result = yield* pruneStaleSymlinks({
            workspaceRoot: workspacePath,
            packages: {},
            dryRun: false,
          })

          expect(result.removed).toContain('shared-lib')
          expect(yield* fs.exists(`${workspacePath}/shared-lib`)).toBe(false)
        }),
      ))

    it('does not remove current symlinks', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          const packages = {
            'shared-lib': { repo: 'repo-a', path: 'shared-lib' },
          }

          yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages,
            dryRun: false,
            force: false,
          })

          // Prune with same packages (so symlink is not stale)
          const result = yield* pruneStaleSymlinks({
            workspaceRoot: workspacePath,
            packages,
            dryRun: false,
          })

          expect(result.removed).toHaveLength(0)
          expect(yield* fs.exists(`${workspacePath}/shared-lib`)).toBe(true)
        }),
      ))

    it('dry run does not remove symlinks', () =>
      withTestCtx(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspacePath = yield* createWorkspace({
            repos: [{ name: 'repo-a', isGitRepo: true }],
          })

          yield* createPackageTarget({
            repoPath: `${workspacePath}/repo-a`,
            packagePath: 'shared-lib',
          })

          yield* syncSymlinks({
            workspaceRoot: workspacePath,
            packages: { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
            dryRun: false,
            force: false,
          })

          // Prune with dry run
          const result = yield* pruneStaleSymlinks({
            workspaceRoot: workspacePath,
            packages: {},
            dryRun: true,
          })

          expect(result.removed).toContain('shared-lib')
          // But symlink should still exist
          expect(yield* fs.exists(`${workspacePath}/shared-lib`)).toBe(true)
        }),
      ))
  })
})
