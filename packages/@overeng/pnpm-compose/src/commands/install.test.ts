/**
 * Integration tests for pnpm-compose install command.
 *
 * These tests create real directory structures with pnpm to verify
 * the install command behavior. They're slower but catch real regressions.
 */
import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { expect } from 'vitest'

import {
  findAllSubmodules,
  findDuplicates,
  updateSubmoduleWithReference,
} from '../submodule-dedupe.ts'
import {
  createPnpmStateFile,
  createTestEnv,
  setupBasicMonorepo,
  setupNestedSubmodules,
  type TestEnv,
} from '../test-helpers/setup.ts'

const TestLayer = NodeContext.layer

describe('install command', () => {
  /** Helper to create and cleanup test env within an effect */
  const withTestEnv = <A, E, R>(fn: (env: TestEnv) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* createTestEnv({ name: 'install-test' })
      try {
        return yield* fn(env)
      } finally {
        yield* env.cleanup()
      }
    })

  /** Run pnpm-compose CLI in test environment */
  const runCli = (env: TestEnv, args: string[]) =>
    Effect.gen(function* () {
      const cliPath = new URL('../cli.ts', import.meta.url).pathname
      return yield* env.run({ cmd: 'bun', args: [cliPath, 'install', ...args], cwd: env.root })
    })

  describe('corruption detection', () => {
    it.effect('detects pnpm node_modules in submodules via .modules.yaml', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // Simulate corruption: create pnpm state file in submodule
          yield* createPnpmStateFile({ env, nodeModulesPath: 'submodules/lib/node_modules' })

          // Verify the corruption marker exists
          const hasModulesYaml = yield* env.exists('submodules/lib/node_modules/.modules.yaml')
          expect(hasModulesYaml).toBe(true)

          // Run pnpm-compose install
          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should detect and clean the corruption
          expect(output).toContain('Detected node_modules in submodules')
          expect(output).toContain('submodules/lib/node_modules')
          expect(output).toContain('Auto-cleaning')

          // Verify corruption was cleaned
          const stillExists = yield* env.exists('submodules/lib/node_modules/.modules.yaml')
          expect(stillExists).toBe(false)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('detects pnpm node_modules in submodules via .pnpm directory', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // Simulate corruption: create .pnpm directory (without .modules.yaml)
          yield* env.writeFile({ path: 'submodules/lib/node_modules/.pnpm/.keep', content: '' })

          // Verify the corruption marker exists
          const hasPnpmDir = yield* env.exists('submodules/lib/node_modules/.pnpm')
          expect(hasPnpmDir).toBe(true)

          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should detect and clean
          expect(output).toContain('Detected node_modules in submodules')
          expect(output).toContain('Auto-cleaning')

          // Verify cleaned
          const stillExists = yield* env.exists('submodules/lib/node_modules/.pnpm')
          expect(stillExists).toBe(false)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('ignores non-pnpm node_modules (e.g., from bun)', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // Create bun-style node_modules (no .modules.yaml or .pnpm)
          yield* env.writeFile({
            path: 'submodules/lib/node_modules/.bin/some-tool',
            content: '#!/bin/bash\necho hi',
          })
          yield* env.writeFile({
            path: 'submodules/lib/node_modules/some-pkg/package.json',
            content: '{"name":"some-pkg"}',
          })

          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should NOT detect corruption for non-pnpm node_modules
          expect(output).not.toContain('Detected node_modules in submodules')

          // node_modules should still exist
          const stillExists = yield* env.exists('submodules/lib/node_modules/some-pkg')
          expect(stillExists).toBe(true)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('submodule dedupe', () => {
    it.effect(
      'uses git alternates for duplicate submodules',
      () =>
        withTestEnv((env) =>
          Effect.gen(function* () {
            yield* setupNestedSubmodules(env)

            const allSubmodules = yield* findAllSubmodules(env.root)
            const duplicates = findDuplicates(allSubmodules)
            expect(duplicates.length).toBe(1)

            const fs = yield* FileSystem.FileSystem
            const duplicate = duplicates[0]!

            for (const loc of duplicate.locations) {
              if (loc === duplicate.canonical) continue
              yield* updateSubmoduleWithReference({ duplicate, target: loc })
            }

            const linkTarget = yield* env
              .readLink('submodules/lib-a/submodules/utils')
              .pipe(Effect.option)
            expect(Option.isNone(linkTarget)).toBe(true)

            const alternatesPath = `${env.root}/.git/modules/submodules/lib-a/modules/submodules/utils/objects/info/alternates`
            const alternates = yield* fs.readFileString(alternatesPath)
            expect(alternates).toContain(`${env.root}/.git/modules/submodules/utils/objects`)

            yield* env.run({ cmd: 'git', args: ['status', '-s'], cwd: env.root })
            yield* env.run({
              cmd: 'git',
              args: ['status', '-s'],
              cwd: `${env.root}/submodules/lib-a`,
            })
          }),
        ).pipe(Effect.provide(TestLayer), Effect.scoped),
      120_000,
    )
  })

  describe('symlink management', () => {
    it.effect('creates symlinks for submodule packages', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          yield* runCli(env, ['--skip-catalog-check'])

          // Check that symlink was created for @test/utils
          const symlinkExists = yield* env.exists('node_modules/@test/utils')
          expect(symlinkExists).toBe(true)

          // Verify it points to the submodule source
          const target = yield* env.readLink('node_modules/@test/utils')
          expect(target).toContain('submodules/lib/packages/utils')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('skips install when symlinks are already correct', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // First install
          yield* runCli(env, ['--skip-catalog-check'])

          // Second install should skip
          const output = yield* runCli(env, ['--skip-catalog-check'])
          expect(output).toContain('Symlinks already correct, skipping install')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('incremental fix', () => {
    it.effect('fixes only wrong symlinks without full reinstall', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // First install to set up node_modules
          yield* runCli(env, ['--skip-catalog-check'])

          // Corrupt a symlink by removing it
          yield* env.run({ cmd: 'rm', args: ['-rf', 'node_modules/@test/utils'], cwd: env.root })

          // Run install again - should do incremental fix
          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should fix the symlink incrementally (not full install)
          expect(output).toContain('Fixing')
          expect(output).toContain('@test/utils')
          expect(output).not.toContain('Running pnpm install...')

          // Symlink should be restored
          const symlinkExists = yield* env.exists('node_modules/@test/utils')
          expect(symlinkExists).toBe(true)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('clean install', () => {
    it.effect('performs full install when no node_modules exists', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should run full pnpm install
          expect(output).toContain('Running pnpm install')
          expect(output).toContain('Symlinking composed repo packages')
          expect(output).toContain('Install complete')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('performs full install with --clean flag', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // First install
          yield* runCli(env, ['--skip-catalog-check'])

          // Second install with --clean
          const output = yield* runCli(env, ['--skip-catalog-check', '--clean'])

          expect(output).toContain('Removing node_modules')
          expect(output).toContain('Running pnpm install')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
