/**
 * Integration tests for bun-compose check command.
 */
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  createTestEnv,
  setupBasicMonorepo,
  setupMonorepoWithConflicts,
  setupMonorepoWithGenieCatalog,
  type TestEnv,
} from '../test-helpers/setup.ts'

const TestLayer = NodeContext.layer

describe('check command', () => {
  /** Helper to create and cleanup test env within an effect */
  const withTestEnv = <A, E, R>(fn: (env: TestEnv) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* createTestEnv({ name: 'check-test' })
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
      return yield* env.run({ cmd: 'bun', args: [cliPath, 'check', ...args], cwd: env.root })
    })

  describe('catalog alignment', () => {
    it.effect('passes when catalogs are aligned', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('Checking catalog alignment')
          expect(output).toContain('✓ main (package.json)')
          expect(output).toContain('✓ lib (package.json)')
          expect(output).toContain('✓ All catalogs are aligned')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('detects catalog conflicts', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupMonorepoWithConflicts(env)

          // Check command should fail due to conflicts
          const result = yield* Effect.either(runCli(env, []))

          // The command exits with an error, so we check the output contains conflict info
          // Effect CLI will throw on non-zero exit, so we capture the error message
          if (result._tag === 'Left') {
            const errorMsg = String(result.left)
            expect(errorMsg).toContain('effect')
          } else {
            // If it succeeds, the output should contain conflict info
            expect(result.right).toContain('catalog conflict')
          }
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('reads catalog from genie/repo.ts when available', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupMonorepoWithGenieCatalog(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('✓ main (genie/repo.ts)')
          expect(output).toContain('✓ lib (genie/repo.ts)')
          expect(output).toContain('✓ All catalogs are aligned')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('missing repos', () => {
    it.effect('fails when composed repo path is missing', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // Remove the submodule directory
          yield* env.run({ cmd: 'rm', args: ['-rf', 'submodules/lib'], cwd: env.root })

          // Check command should fail
          const result = yield* Effect.either(runCli(env, []))

          if (result._tag === 'Left') {
            const errorMsg = String(result.left)
            expect(errorMsg).toContain('not found')
          } else {
            expect(result.right).toContain('path not found')
          }
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
