/**
 * Integration tests for pnpm-compose dedupe-submodules command.
 *
 * Tests the deduplication of git submodules by creating symlinks.
 */
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { createTestEnv, setupNestedSubmodules, type TestEnv } from '../test-helpers/setup.ts'

const TestLayer = NodeContext.layer

describe('dedupe-submodules command', () => {
  /** Helper to create and cleanup test env */
  const withTestEnv = <A, E, R>(fn: (env: TestEnv) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* createTestEnv({ name: 'dedupe-test' })
      try {
        return yield* fn(env)
      } finally {
        yield* env.cleanup()
      }
    })

  /** Run pnpm-compose dedupe-submodules CLI */
  const runDedupe = (env: TestEnv) =>
    Effect.gen(function* () {
      const cliPath = new URL('../cli.ts', import.meta.url).pathname
      return yield* env.run('bun', [cliPath, 'dedupe-submodules'], env.root)
    })

  describe('duplicate detection', () => {
    it.effect('detects duplicate submodules across nested repos', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupNestedSubmodules(env)

          const output = yield* runDedupe(env)

          // Should detect the duplicate
          expect(output).toContain('Found 1 duplicate submodule')
          expect(output).toContain('https://github.com/test/utils.git')
          expect(output).toContain('Canonical: submodules/utils')
          expect(output).toContain('Duplicate: submodules/lib-a/submodules/utils')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('reports no duplicates when submodules are unique', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          // Initialize parent with single unique submodule
          yield* env.run('git', ['init'])
          yield* env.run('git', ['config', 'user.email', 'test@test.com'])
          yield* env.run('git', ['config', 'user.name', 'Test'])

          yield* env.writeFile(
            '.gitmodules',
            `[submodule "submodules/unique"]
\tpath = submodules/unique
\turl = https://github.com/test/unique.git
`,
          )

          // Create directory first via writeFile
          yield* env.writeFile('submodules/unique/README.md', '# Unique\n')
          yield* env.run('git', ['init'], `${env.root}/submodules/unique`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/unique`,
          )
          yield* env.run('git', ['config', 'user.name', 'Test'], `${env.root}/submodules/unique`)

          const output = yield* runDedupe(env)

          expect(output).toContain('No duplicate submodules found')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('handles workspace with no submodules', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          // Just init git, no .gitmodules
          yield* env.run('git', ['init'])
          yield* env.run('git', ['config', 'user.email', 'test@test.com'])
          yield* env.run('git', ['config', 'user.name', 'Test'])

          const output = yield* runDedupe(env)

          expect(output).toContain('No submodules found in workspace')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('symlink creation', () => {
    it.effect('creates symlinks pointing to canonical (top-level) location', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupNestedSubmodules(env)
          yield* runDedupe(env)

          // Check symlink was created
          const symlinkPath = 'submodules/lib-a/submodules/utils'
          const exists = yield* env.exists(symlinkPath)
          expect(exists).toBe(true)

          // Verify it's a symlink
          const target = yield* env.readLink(symlinkPath)
          expect(target).toBe('../../utils')

          // Verify symlink resolves correctly
          const resolvedExists = yield* env.exists('submodules/lib-a/submodules/utils/package.json')
          expect(resolvedExists).toBe(true)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('removes existing directory before creating symlink', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupNestedSubmodules(env)

          // Verify the duplicate directory exists before deduplication
          const beforeExists = yield* env.exists('submodules/lib-a/submodules/utils/package.json')
          expect(beforeExists).toBe(true)

          yield* runDedupe(env)

          // After deduplication, path should be symlink
          const target = yield* env.readLink('submodules/lib-a/submodules/utils')
          expect(target).toBe('../../utils')

          // And still resolve
          const afterExists = yield* env.exists('submodules/lib-a/submodules/utils/package.json')
          expect(afterExists).toBe(true)
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('adds symlink paths to .git/info/exclude', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupNestedSubmodules(env)
          yield* runDedupe(env)

          // Read .git/info/exclude in lib-a repo
          const excludePath = 'submodules/lib-a/.git/info/exclude'
          const excludeExists = yield* env.exists(excludePath)
          expect(excludeExists).toBe(true)

          const excludeContent = yield* env.readFile(excludePath)
          expect(excludeContent).toContain('submodules/utils')
          expect(excludeContent).toContain('pnpm-compose')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('multiple duplicates', () => {
    it.effect('handles multiple duplicate submodules', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* env.run('git', ['init'])
          yield* env.run('git', ['config', 'user.email', 'test@test.com'])
          yield* env.run('git', ['config', 'user.name', 'Test'])

          // Top-level .gitmodules with two shared submodules
          yield* env.writeFile(
            '.gitmodules',
            `[submodule "submodules/utils"]
\tpath = submodules/utils
\turl = https://github.com/test/utils.git

[submodule "submodules/core"]
\tpath = submodules/core
\turl = https://github.com/test/core.git

[submodule "submodules/app"]
\tpath = submodules/app
\turl = https://github.com/test/app.git
`,
          )

          // Create utils submodule - writeFile first to create directory
          yield* env.writeFile('submodules/utils/index.ts', 'export const utils = 1\n')
          yield* env.run('git', ['init'], `${env.root}/submodules/utils`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/utils`,
          )
          yield* env.run('git', ['config', 'user.name', 'Test'], `${env.root}/submodules/utils`)

          // Create core submodule
          yield* env.writeFile('submodules/core/index.ts', 'export const core = 2\n')
          yield* env.run('git', ['init'], `${env.root}/submodules/core`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/core`,
          )
          yield* env.run('git', ['config', 'user.name', 'Test'], `${env.root}/submodules/core`)

          // Create app submodule that references both utils and core (duplicates!)
          yield* env.writeFile('submodules/app/index.ts', 'export const app = 3\n')
          yield* env.run('git', ['init'], `${env.root}/submodules/app`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/app`,
          )
          yield* env.run('git', ['config', 'user.name', 'Test'], `${env.root}/submodules/app`)

          yield* env.writeFile(
            'submodules/app/.gitmodules',
            `[submodule "submodules/utils"]
\tpath = submodules/utils
\turl = https://github.com/test/utils.git

[submodule "submodules/core"]
\tpath = submodules/core
\turl = https://github.com/test/core.git
`,
          )

          // Create duplicate utils and core in app
          yield* env.writeFile(
            'submodules/app/submodules/utils/index.ts',
            'export const utils = 1\n',
          )
          yield* env.run('git', ['init'], `${env.root}/submodules/app/submodules/utils`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/app/submodules/utils`,
          )
          yield* env.run(
            'git',
            ['config', 'user.name', 'Test'],
            `${env.root}/submodules/app/submodules/utils`,
          )

          yield* env.writeFile('submodules/app/submodules/core/index.ts', 'export const core = 2\n')
          yield* env.run('git', ['init'], `${env.root}/submodules/app/submodules/core`)
          yield* env.run(
            'git',
            ['config', 'user.email', 'test@test.com'],
            `${env.root}/submodules/app/submodules/core`,
          )
          yield* env.run(
            'git',
            ['config', 'user.name', 'Test'],
            `${env.root}/submodules/app/submodules/core`,
          )

          const output = yield* runDedupe(env)

          // Should detect both duplicates
          expect(output).toContain('Found 2 duplicate submodule')
          expect(output).toContain('https://github.com/test/utils.git')
          expect(output).toContain('https://github.com/test/core.git')
          expect(output).toContain('Created 2 symlink(s)')

          // Verify both symlinks
          const utilsTarget = yield* env.readLink('submodules/app/submodules/utils')
          expect(utilsTarget).toBe('../../utils')

          const coreTarget = yield* env.readLink('submodules/app/submodules/core')
          expect(coreTarget).toBe('../../core')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  describe('idempotency', () => {
    it.effect('running dedupe twice is safe (idempotent)', () =>
      withTestEnv((env) =>
        Effect.gen(function* () {
          yield* setupNestedSubmodules(env)

          // First run
          const output1 = yield* runDedupe(env)
          expect(output1).toContain('Created 2 symlink(s)')

          // Second run - should work without errors
          const output2 = yield* runDedupe(env)
          expect(output2).toContain('Created 2 symlink(s)')

          // Symlink should still be valid
          const target = yield* env.readLink('submodules/lib-a/submodules/utils')
          expect(target).toBe('../../utils')
        }),
      ).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
