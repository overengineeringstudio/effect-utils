/**
 * Integration tests for pnpm-compose install command.
 *
 * These tests create real directory structures with pnpm to verify
 * the install command behavior. They're slower but catch real regressions.
 */
import { Command, Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { expect } from 'vitest'

import {
  findAllSubmodules,
  findDuplicates,
  pickCanonicalSubmodule,
  syncSubmoduleGitlink,
  updateSubmoduleWithSymlink,
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

  /** Run pnpm-compose CLI and return only the exit code. */
  const runCliExitCode = (env: TestEnv, args: string[]) =>
    Effect.gen(function* () {
      const cliPath = new URL('../cli.ts', import.meta.url).pathname
      const command = Command.make('bun', cliPath, 'install', ...args).pipe(
        Command.workingDirectory(env.root),
      )
      return yield* Command.exitCode(command)
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

          // Non-pnpm node_modules are cleaned when syncing submodule root deps
          const stillExists = yield* env.exists('submodules/lib/node_modules/some-pkg')
          expect(stillExists).toBe(false)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('submodule dedupe', () => {
    it.effect(
      'symlinks duplicate submodules and configures ignore rules',
      () =>
        withTestEnv((env) =>
          Effect.gen(function* () {
            yield* setupNestedSubmodules(env)

            const allSubmodules = yield* findAllSubmodules(env.root)
            const duplicates = findDuplicates(allSubmodules)
            expect(duplicates.length).toBe(1)

            const duplicate = duplicates[0]!
            const canonical = yield* pickCanonicalSubmodule(duplicate)

            for (const loc of duplicate.locations) {
              if (loc === canonical) continue
              yield* updateSubmoduleWithSymlink({ canonical, target: loc })
            }

            const path = yield* Path.Path
            const target = duplicate.locations.find((loc) => loc !== canonical)
            if (!target) {
              return yield* Effect.die('Expected a non-canonical duplicate location')
            }

            const targetPath = path.join(target.repoRoot, target.path)
            const targetRelative = path.relative(env.root, targetPath)
            const linkTarget = yield* env.readLink(targetRelative).pipe(Effect.option)
            expect(Option.isSome(linkTarget)).toBe(true)

            if (Option.isSome(linkTarget)) {
              const resolvedTarget = path.resolve(path.dirname(targetPath), linkTarget.value)
              expect(resolvedTarget).toBe(`${env.root}/submodules/utils`)
            }

            const ignoreSetting = yield* env.run({
              cmd: 'git',
              args: ['config', '--get', 'submodule.submodules/utils.ignore'],
              cwd: `${env.root}/submodules/lib-a`,
            })
            expect(ignoreSetting).toBe('all')
            /**
             * Git status can stall on symlinked submodules in temp repos,
             * so we rely on the ignore config assertion here.
             */
          }),
        ).pipe(Effect.provide(TestLayer), Effect.scoped),
      120_000,
    )

    it.effect(
      'syncs gitlink to canonical HEAD for symlinked duplicates',
      () =>
        withTestEnv((env) =>
          Effect.gen(function* () {
            yield* setupNestedSubmodules(env)

            const allSubmodules = yield* findAllSubmodules(env.root)
            const duplicates = findDuplicates(allSubmodules)
            expect(duplicates.length).toBe(1)

            const duplicate = duplicates[0]!
            const canonical = yield* pickCanonicalSubmodule(duplicate)

            for (const loc of duplicate.locations) {
              if (loc === canonical) continue
              yield* updateSubmoduleWithSymlink({ canonical, target: loc })
            }

            const canonicalPath = `${env.root}/submodules/utils`
            yield* env.run({
              cmd: 'git',
              args: ['config', 'user.email', 'test@test.com'],
              cwd: canonicalPath,
            })
            yield* env.run({
              cmd: 'git',
              args: ['config', 'user.name', 'Test'],
              cwd: canonicalPath,
            })
            yield* env.run({
              cmd: 'git',
              args: ['config', 'commit.gpgsign', 'false'],
              cwd: canonicalPath,
            })
            yield* env.writeFile({
              path: 'submodules/utils/CHANGELOG.md',
              content: 'update\n',
            })
            yield* env.run({ cmd: 'git', args: ['add', 'CHANGELOG.md'], cwd: canonicalPath })
            yield* env.run({
              cmd: 'git',
              args: ['commit', '-m', 'update utils'],
              cwd: canonicalPath,
            })

            const canonicalSha = yield* env.run({
              cmd: 'git',
              args: ['rev-parse', 'HEAD'],
              cwd: canonicalPath,
            })

            const target = duplicate.locations.find((loc) => loc !== canonical)
            if (!target) {
              return yield* Effect.die('Expected a non-canonical duplicate location')
            }

            yield* syncSubmoduleGitlink({ canonical, target })

            const lsFiles = yield* env.run({
              cmd: 'git',
              args: ['ls-files', '-s', target.path],
              cwd: target.repoRoot,
            })
            expect(lsFiles).toContain(canonicalSha)
            /**
             * Skip git status here to avoid stalls in symlinked submodule repos.
             */
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

    it.effect('links submodule root deps and bins', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const submodulePkgPath = 'submodules/lib/package.json'
          const submodulePkgRaw = yield* env.readFile(submodulePkgPath)
          const submodulePkg = JSON.parse(submodulePkgRaw) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
          }
          submodulePkg.dependencies = { foo: '1.0.0' }
          submodulePkg.devDependencies = { bar: '1.0.0' }
          yield* env.writeFile({
            path: submodulePkgPath,
            content: JSON.stringify(submodulePkg, null, 2),
          })

          yield* env.writeFile({
            path: 'node_modules/foo/package.json',
            content: JSON.stringify(
              { name: 'foo', version: '1.0.0', bin: { foo: 'bin/foo' } },
              null,
              2,
            ),
          })
          yield* env.writeFile({
            path: 'node_modules/foo/bin/foo',
            content: '#!/usr/bin/env node\n',
          })
          yield* env.writeFile({
            path: 'node_modules/bar/package.json',
            content: JSON.stringify({ name: 'bar', version: '1.0.0', bin: 'bin/bar' }, null, 2),
          })
          yield* env.writeFile({
            path: 'node_modules/bar/bin/bar',
            content: '#!/usr/bin/env node\n',
          })
          yield* env.writeFile({ path: 'node_modules/.bin/.keep', content: '' })
          yield* env.run({
            cmd: 'ln',
            args: ['-s', '../foo/bin/foo', 'node_modules/.bin/foo'],
          })
          yield* env.run({
            cmd: 'ln',
            args: ['-s', '../bar/bin/bar', 'node_modules/.bin/bar'],
          })

          const path = yield* Path.Path
          yield* env.run({ cmd: 'mkdir', args: ['-p', 'node_modules/@test'] })
          yield* env.run({
            cmd: 'ln',
            args: [
              '-s',
              path.join(env.root, 'submodules/lib/packages/utils'),
              'node_modules/@test/utils',
            ],
          })

          yield* env.writeFile({
            path: 'submodules/lib/node_modules/stale/package.json',
            content: '{}',
          })
          yield* env.writeFile({
            path: 'submodules/lib/node_modules/.bin/old',
            content: '',
          })

          const output = yield* runCli(env, ['--skip-catalog-check'])
          expect(output).toContain('Linked')

          const fooLink = yield* env.readLink('submodules/lib/node_modules/foo')
          const fooResolved = path.resolve(`${env.root}/submodules/lib/node_modules`, fooLink)
          expect(fooResolved.endsWith('/node_modules/foo')).toBe(true)

          const barLink = yield* env.readLink('submodules/lib/node_modules/bar')
          const barResolved = path.resolve(`${env.root}/submodules/lib/node_modules`, barLink)
          expect(barResolved.endsWith('/node_modules/bar')).toBe(true)

          const binFoo = yield* env.readLink('submodules/lib/node_modules/.bin/foo')
          const binFooResolved = path.resolve(
            `${env.root}/submodules/lib/node_modules/.bin`,
            binFoo,
          )
          expect(binFooResolved.endsWith('/node_modules/.bin/foo')).toBe(true)

          const staleExists = yield* env.exists('submodules/lib/node_modules/stale')
          expect(staleExists).toBe(false)

          const oldBinExists = yield* env.exists('submodules/lib/node_modules/.bin/old')
          expect(oldBinExists).toBe(false)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('fails when root deps or bins are missing', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const submodulePkgPath = 'submodules/lib/package.json'
          const submodulePkgRaw = yield* env.readFile(submodulePkgPath)
          const submodulePkg = JSON.parse(submodulePkgRaw) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
          }
          submodulePkg.dependencies = { foo: '1.0.0', bar: '1.0.0' }
          yield* env.writeFile({
            path: submodulePkgPath,
            content: JSON.stringify(submodulePkg, null, 2),
          })

          yield* env.writeFile({
            path: 'node_modules/bar/package.json',
            content: JSON.stringify({ name: 'bar', version: '1.0.0', bin: 'bin/bar' }, null, 2),
          })
          yield* env.writeFile({
            path: 'node_modules/bar/bin/bar',
            content: '#!/usr/bin/env node\n',
          })

          /** Keep the workspace package symlink valid so the install path stays incremental. */
          const path = yield* Path.Path
          yield* env.run({ cmd: 'mkdir', args: ['-p', 'node_modules/@test'] })
          yield* env.run({
            cmd: 'ln',
            args: [
              '-s',
              path.join(env.root, 'submodules/lib/packages/utils'),
              'node_modules/@test/utils',
            ],
          })

          const exitCode = yield* runCliExitCode(env, ['--skip-catalog-check'])
          expect(exitCode).not.toBe(0)

          const fooExists = yield* env.exists('submodules/lib/node_modules/foo')
          expect(fooExists).toBe(false)

          const barExists = yield* env.exists('submodules/lib/node_modules/bar')
          expect(barExists).toBe(false)

          const binBarExists = yield* env.exists('submodules/lib/node_modules/.bin/bar')
          expect(binBarExists).toBe(false)
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
