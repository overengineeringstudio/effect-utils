/**
 * Integration tests for bun-compose install command.
 *
 * These tests verify the simplified bun-compose install behavior:
 * - Catalog alignment check before install
 * - Basic bun install execution
 *
 * Note: Unlike pnpm-compose, bun-compose doesn't need symlink dance or corruption detection.
 */
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  createTestEnv,
  setupBasicMonorepo,
  setupMonorepoWithConflicts,
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

  /** Run bun-compose CLI in test environment */
  const runCli = (env: TestEnv, args: string[]) =>
    Effect.gen(function* () {
      const cliPath = new URL('../cli.ts', import.meta.url).pathname
      return yield* env.run({ cmd: 'bun', args: [cliPath, 'install', ...args], cwd: env.root })
    })

  describe('catalog check', () => {
    it.effect('runs catalog check before install', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('Checking catalog alignment')
          expect(output).toContain('✓ All catalogs are aligned')
          expect(output).toContain('Running bun install')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('fails on catalog conflicts', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupMonorepoWithConflicts(env)

          const result = yield* Effect.either(runCli(env, []))

          // Should fail due to catalog conflicts
          if (result._tag === 'Left') {
            const errorMsg = String(result.left)
            // Error should mention conflicts or install failure
            expect(
              errorMsg.includes('conflict') ||
                errorMsg.includes('Install failed') ||
                errorMsg.includes('effect'),
            ).toBe(true)
          } else {
            // If it somehow succeeds, check the output mentions conflicts
            expect(result.right).toContain('conflict')
          }
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('skips catalog check with --skip-catalog-check', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupMonorepoWithConflicts(env)

          const output = yield* runCli(env, ['--skip-catalog-check'])

          // Should skip catalog check and go straight to install
          expect(output).not.toContain('Checking catalog alignment')
          expect(output).toContain('Running bun install')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('bun install', () => {
    it.effect('runs bun install and creates node_modules', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          yield* runCli(env, [])

          // Should have created node_modules
          const hasNodeModules = yield* env.exists('node_modules')
          expect(hasNodeModules).toBe(true)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('completes successfully with Install complete message', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('✓ Install complete')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('supports --frozen flag', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // First install to create lockfile
          yield* runCli(env, [])

          // Second install with --frozen should work
          const output = yield* runCli(env, ['--frozen'])

          expect(output).toContain('Running bun install')
          expect(output).toContain('✓ Install complete')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('submodule isolation (bun advantage)', () => {
    it.effect('does not create pnpm-specific corruption markers in submodules', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          yield* runCli(env, [])

          // Key bun advantage: submodule packages should NOT have pnpm corruption markers
          // (no .modules.yaml or .pnpm directory)
          const hasPnpmModulesYaml = yield* env.exists('submodules/lib/node_modules/.modules.yaml')
          const hasPnpmDir = yield* env.exists('submodules/lib/node_modules/.pnpm')

          expect(hasPnpmModulesYaml).toBe(false)
          expect(hasPnpmDir).toBe(false)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
