/**
 * Tests for dotdot link command
 */

import fs from 'node:fs'
import path from 'node:path'

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { linkSubcommands } from '../src/commands/link.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import {
  cleanupWorkspace,
  createPackageTarget,
  createWorkspace,
  generateConfigWithPackages,
} from './fixtures/setup.ts'

describe('link command', () => {
  let workspacePath: string

  afterEach(() => {
    if (workspacePath) {
      cleanupWorkspace(workspacePath)
    }
  })

  it('creates symlinks from packages config', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    // Create package target
    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')

    // Update config with packages
    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check symlink was created
    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(true)
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true)

    // Check symlink target is correct
    const linkTarget = fs.readlinkSync(symlinkPath)
    expect(linkTarget).toBe('repo-a/shared-lib')
  })

  it('dry run does not create symlinks', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: true, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check symlink was NOT created
    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(false)
  })

  it('detects conflicts when multiple repos expose same package name', async () => {
    workspacePath = createWorkspace({
      repos: [
        { name: 'repo-a', isGitRepo: true },
        { name: 'repo-b', isGitRepo: true },
      ],
    })

    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')
    createPackageTarget(path.join(workspacePath, 'repo-b'), 'shared-lib')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
        'repo-b': {
          url: 'git@github.com:test/repo-b.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Symlink should NOT be created due to conflict (without --force)
    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(false)
  })

  it('force overwrites conflicts', async () => {
    workspacePath = createWorkspace({
      repos: [
        { name: 'repo-a', isGitRepo: true },
        { name: 'repo-b', isGitRepo: true },
      ],
    })

    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')
    createPackageTarget(path.join(workspacePath, 'repo-b'), 'shared-lib')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
        'repo-b': {
          url: 'git@github.com:test/repo-b.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: true })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check symlink was created (first match wins)
    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(true)
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
  })

  it('remove subcommand removes existing symlinks', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    // First create symlinks using the create command
    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(true)

    // Remove symlinks
    await Effect.gen(function* () {
      yield* linkSubcommands.remove.handler({ dryRun: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Symlink should be removed
    expect(fs.existsSync(symlinkPath)).toBe(false)
  })

  it('remove and create subcommands work together', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    createPackageTarget(path.join(workspacePath, 'repo-a'), 'shared-lib')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { 'shared-lib': { path: 'shared-lib' } },
        },
      }),
    )

    // Create symlink first
    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    const symlinkPath = path.join(workspacePath, 'shared-lib')
    expect(fs.existsSync(symlinkPath)).toBe(true)

    // Remove and then recreate
    await Effect.gen(function* () {
      yield* linkSubcommands.remove.handler({ dryRun: false })
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Symlink should still exist (removed and recreated)
    expect(fs.existsSync(symlinkPath)).toBe(true)
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
  })

  it('skips when source does not exist', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    // Don't create the package target

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { nonexistent: { path: 'nonexistent' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check symlink was NOT created
    const symlinkPath = path.join(workspacePath, 'nonexistent')
    expect(fs.existsSync(symlinkPath)).toBe(false)
  })

  it('handles empty packages config', async () => {
    workspacePath = createWorkspace({
      repos: [],
    })

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(true).toBe(true)
  })

  it('supports different package name than path', async () => {
    workspacePath = createWorkspace({
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    // Create package at nested path
    createPackageTarget(path.join(workspacePath, 'repo-a'), 'packages/utils')

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      generateConfigWithPackages({
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          packages: { '@org/utils': { path: 'packages/utils' } },
        },
      }),
    )

    await Effect.gen(function* () {
      yield* linkSubcommands.create.handler({ dryRun: false, force: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check symlink was created with package name (not path)
    const symlinkPath = path.join(workspacePath, '@org/utils')
    expect(fs.existsSync(symlinkPath)).toBe(true)
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true)

    // Check symlink target is the nested path (relative from @org directory)
    const linkTarget = fs.readlinkSync(symlinkPath)
    expect(linkTarget).toBe('../repo-a/packages/utils')
  })
})
