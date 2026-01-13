/**
 * Integration tests for dotdot link command
 */

import { FileSystem } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { CurrentWorkingDirectory } from '../lib/mod.ts'
import {
  createPackageTarget,
  createWorkspace,
  generateRootConfig,
  withTestCtx,
} from '../test-utils/mod.ts'
import { linkSubcommands } from './link.ts'

describe('link command', () => {
  it('creates symlinks from packages config', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        // Create package target
        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')

        // Update config with packages
        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
          ),
        )

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check symlink was created
        const symlinkPath = `${workspacePath}/shared-lib`
        const exists = yield* fs.exists(symlinkPath)
        expect(exists).toBe(true)

        const stat = yield* fs.stat(symlinkPath)
        expect(stat.type).toBe('SymbolicLink')

        // Check symlink target is correct
        const linkTarget = yield* fs.readLink(symlinkPath)
        expect(linkTarget).toBe('repo-a/shared-lib')
      }),
    ))

  it('dry run does not create symlinks', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
          ),
        )

        yield* linkSubcommands.create
          .handler({ dryRun: true, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check symlink was NOT created
        const exists = yield* fs.exists(`${workspacePath}/shared-lib`)
        expect(exists).toBe(false)
      }),
    ))

  it('creates symlinks for packages with different names', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [
            { name: 'repo-a', isGitRepo: true },
            { name: 'repo-b', isGitRepo: true },
          ],
        })

        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')
        yield* createPackageTarget(`${workspacePath}/repo-b`, 'shared-lib')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            {
              'repo-a': { url: 'git@github.com:test/repo-a.git' },
              'repo-b': { url: 'git@github.com:test/repo-b.git' },
            },
            {
              'shared-lib-a': { repo: 'repo-a', path: 'shared-lib' },
              'shared-lib-b': { repo: 'repo-b', path: 'shared-lib' },
            },
          ),
        )

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Both symlinks should be created
        expect(yield* fs.exists(`${workspacePath}/shared-lib-a`)).toBe(true)
        expect(yield* fs.exists(`${workspacePath}/shared-lib-b`)).toBe(true)
      }),
    ))

  it('force overwrites existing symlinks', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
          ),
        )

        // Create an existing file where the symlink should go
        const symlinkPath = `${workspacePath}/shared-lib`
        yield* fs.writeFileString(symlinkPath, 'existing file')

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: true })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check symlink was created (force overwrote the file)
        const stat = yield* fs.stat(symlinkPath)
        expect(stat.type).toBe('SymbolicLink')
      }),
    ))

  it('remove subcommand removes existing symlinks', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
          ),
        )

        const cwdLayer = CurrentWorkingDirectory.fromPath(workspacePath)

        // First create symlinks
        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(cwdLayer))

        const symlinkPath = `${workspacePath}/shared-lib`
        expect(yield* fs.exists(symlinkPath)).toBe(true)

        // Remove symlinks
        yield* linkSubcommands.remove.handler({ dryRun: false }).pipe(Effect.provide(cwdLayer))

        // Symlink should be removed
        expect(yield* fs.exists(symlinkPath)).toBe(false)
      }),
    ))

  it('remove and create subcommands work together', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        yield* createPackageTarget(`${workspacePath}/repo-a`, 'shared-lib')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { 'shared-lib': { repo: 'repo-a', path: 'shared-lib' } },
          ),
        )

        const cwdLayer = CurrentWorkingDirectory.fromPath(workspacePath)
        const symlinkPath = `${workspacePath}/shared-lib`

        // Create symlink first
        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(cwdLayer))
        expect(yield* fs.exists(symlinkPath)).toBe(true)

        // Remove and then recreate
        yield* linkSubcommands.remove.handler({ dryRun: false }).pipe(Effect.provide(cwdLayer))
        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(cwdLayer))

        // Symlink should still exist
        const stat = yield* fs.stat(symlinkPath)
        expect(stat.type).toBe('SymbolicLink')
      }),
    ))

  it('skips when source does not exist', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        // Don't create the package target

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { nonexistent: { repo: 'repo-a', path: 'nonexistent' } },
          ),
        )

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check symlink was NOT created
        expect(yield* fs.exists(`${workspacePath}/nonexistent`)).toBe(false)
      }),
    ))

  it('handles empty packages config', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          repos: [],
        })

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('supports different package name than path', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        // Create package at nested path
        yield* createPackageTarget(`${workspacePath}/repo-a`, 'packages/utils')

        yield* fs.writeFileString(
          `${workspacePath}/dotdot-root.json`,
          generateRootConfig(
            { 'repo-a': { url: 'git@github.com:test/repo-a.git' } },
            { '@org/utils': { repo: 'repo-a', path: 'packages/utils' } },
          ),
        )

        yield* linkSubcommands.create
          .handler({ dryRun: false, force: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check symlink was created with package name
        const symlinkPath = `${workspacePath}/@org/utils`
        const stat = yield* fs.stat(symlinkPath)
        expect(stat.type).toBe('SymbolicLink')

        // Check symlink target is the nested path
        const linkTarget = yield* fs.readLink(symlinkPath)
        expect(linkTarget).toBe('../repo-a/packages/utils')
      }),
    ))
})
