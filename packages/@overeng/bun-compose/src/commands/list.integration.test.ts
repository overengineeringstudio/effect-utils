/**
 * Integration tests for bun-compose list command.
 */
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  createTestEnv,
  setupBasicMonorepo,
  setupMonorepoWithGenieCatalog,
  type TestEnv,
} from '../test-helpers/setup.ts'

const TestLayer = NodeContext.layer

describe('list command', () => {
  /** Helper to create and cleanup test env within an effect */
  const withTestEnv = <A, E, R>(fn: (env: TestEnv) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* createTestEnv({ name: 'list-test' })
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
      return yield* env.run({ cmd: 'bun', args: [cliPath, 'list', ...args], cwd: env.root })
    })

  describe('repo listing', () => {
    it.effect('lists main repo and composed repos with package.json catalogs', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('Composed repos:')
          expect(output).toContain('main (root)')
          expect(output).toContain('package.json')
          expect(output).toContain('lib')
          expect(output).toContain('submodules/lib')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('lists repos with genie/repo.ts catalogs', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupMonorepoWithGenieCatalog(env)

          const output = yield* runCli(env, [])

          expect(output).toContain('Composed repos:')
          expect(output).toContain('main (root)')
          expect(output).toContain('genie/repo.ts')
          expect(output).toContain('lib')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('shows package count in catalog', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          const output = yield* runCli(env, [])

          // The basic monorepo has 1 package in catalog (effect)
          expect(output).toMatch(/\d+ packages?\)/)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('handles missing submodule paths gracefully', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupBasicMonorepo(env)

          // Remove the submodule directory
          yield* env.run({ cmd: 'rm', args: ['-rf', 'submodules/lib'], cwd: env.root })

          const output = yield* runCli(env, [])

          expect(output).toContain('lib')
          expect(output).toContain('not found')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('shows message when no submodules found', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          // Create a minimal monorepo without submodules
          yield* env.run({ cmd: 'git', args: ['init'] })
          yield* env.writeFile({
            path: 'package.json',
            content: JSON.stringify(
              {
                name: 'test-monorepo',
                private: true,
                workspaces: {
                  packages: ['packages/*'],
                  catalog: { effect: '3.19.0' },
                },
              },
              null,
              2,
            ),
          })

          const output = yield* runCli(env, [])

          expect(output).toContain('Composed repos:')
          expect(output).toContain('main (root)')
          expect(output).toContain('No composed repos detected')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
