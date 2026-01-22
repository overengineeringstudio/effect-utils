import * as crypto from 'node:crypto'
import * as os from 'node:os'
import nodePath from 'node:path'

import { Command, FileSystem, Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { expect } from 'vitest'

type TestEnv = {
  root: string
  writeFile: (args: { path: string; content: string }) => Effect.Effect<void, never>
  symlink: (args: { target: string; path: string }) => Effect.Effect<void, never>
  cleanup: () => Effect.Effect<void, never>
}

const TestLayer = NodeContext.layer

const createTestEnv = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(os.tmpdir(), `genie-cli-test-${crypto.randomBytes(4).toString('hex')}`)

  yield* fs.makeDirectory(root, { recursive: true })

  const writeFile = Effect.fnUntraced(function* ({
    path: relativePath,
    content,
  }: {
    path: string
    content: string
  }) {
    const fullPath = path.join(root, relativePath)
    const dir = path.dirname(fullPath)
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(fullPath, content)
  }, Effect.orDie)

  const symlink = Effect.fnUntraced(function* ({
    target,
    path: relativePath,
  }: {
    target: string
    path: string
  }) {
    const targetPath = path.isAbsolute(target) ? target : path.join(root, target)
    const linkPath = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath)
    yield* fs.makeDirectory(path.dirname(linkPath), { recursive: true })
    yield* fs.symlink(targetPath, linkPath)
  }, Effect.orDie)

  const cleanup = () => fs.remove(root, { recursive: true }).pipe(Effect.ignore)

  return { root, writeFile, symlink, cleanup } satisfies TestEnv
})

const decodeChunks = (chunks: Chunk.Chunk<Uint8Array>): string => {
  const merged = Chunk.toReadonlyArray(chunks).reduce((acc, chunk) => {
    const result = new Uint8Array(acc.length + chunk.length)
    result.set(acc)
    result.set(chunk, acc.length)
    return result
  }, new Uint8Array())

  return new TextDecoder().decode(merged)
}

const runGenie = Effect.fnUntraced(function* (env: TestEnv, args: ReadonlyArray<string>) {
  const cliPath = new URL('./mod.ts', import.meta.url).pathname
  const command = Command.make('bun', cliPath, '--cwd', env.root, ...args).pipe(
    Command.workingDirectory(env.root),
    Command.stdout('pipe'),
    Command.stderr('pipe'),
  )

  const process = yield* Command.start(command)
  const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
    Stream.runCollect(process.stdout),
    Stream.runCollect(process.stderr),
    process.exitCode,
  ])

  return {
    stdout: decodeChunks(stdoutChunks),
    stderr: decodeChunks(stderrChunks),
    exitCode,
  }
}, Effect.scoped)

describe('genie cli', () => {
  const withTestEnv = Effect.fnUntraced(function* <A, E, R>(
    fn: (env: TestEnv) => Effect.Effect<A, E, R>,
  ) {
    const env = yield* createTestEnv()
    try {
      return yield* fn(env)
    } finally {
      yield* env.cleanup()
    }
  })

  it.effect(
    'reports import errors with clear error message',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            const packageJsonContent = yield* Schema.encode(
              Schema.parseJson(Schema.Unknown, { space: 2 }),
            )({ name: 'genie-cli-test', private: true })

            yield* env.writeFile({
              path: 'package.json',
              content: packageJsonContent,
            })

            yield* env.writeFile({
              path: 'genie/repo.ts',
              content: `export const pkg = {
  root: (config: unknown) => JSON.stringify(config),
}
`,
            })

            /** Simulate a TDZ-style error (ReferenceError) in the genie file */
            yield* env.writeFile({
              path: 'package.json.genie.ts',
              content: `import { pkg } from './genie/repo.ts'

throw new ReferenceError('Cannot access \\'pkg\\' before initialization')

export default pkg.root({ name: 'genie-cli-test' })
`,
            })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--check'])
            const output = `${stdout}\n${stderr}`

            expect(exitCode).not.toBe(0)
            expect(output).toContain('GenieImportError')
            expect(output).toContain('package.json.genie.ts')
            expect(output).toContain('Cannot access')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect(
    'skips symlinked directories that resolve inside the root',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * The symlink points back into the same root; we should only process the
             * canonical target once to avoid duplicate generation via the symlinked path.
             */
            yield* env.writeFile({
              path: 'canonical/package.json.genie.ts',
              content: `export default {
  data: { name: 'genie-cli-test', private: true },
  stringify: () => JSON.stringify({ name: 'genie-cli-test', private: true }),
}`,
            })

            yield* env.symlink({ target: 'canonical', path: 'link' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`
            const canonicalOutput = nodePath.join(env.root, 'canonical', 'package.json')
            const linkOutput = nodePath.join(env.root, 'link', 'package.json')

            expect(exitCode).toBe(0)
            expect(output).toContain('Summary: 1 files processed')
            expect(output).toContain(canonicalOutput)
            expect(output).not.toContain(linkOutput)
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect(
    're-validates on TDZ errors to identify root causes',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * When a shared module throws during initialization, dependent genie files
             * may see TDZ errors. The CLI should detect this and re-validate sequentially
             * to identify the actual root cause.
             */

            // Root cause: shared module that throws during initialization
            yield* env.writeFile({
              path: 'genie/internal.ts',
              content: `export const catalog = (() => {
  throw new Error('Missing required env var DATABASE_URL')
})()
`,
            })

            // Dependent: imports from the failing module
            yield* env.writeFile({
              path: 'apps/app/package.json.genie.ts',
              content: `import { catalog } from '../../genie/internal.ts'
export default {
  data: { dependencies: catalog },
  stringify: () => JSON.stringify({ dependencies: catalog }),
}
`,
            })

            // Another dependent
            yield* env.writeFile({
              path: 'packages/lib/package.json.genie.ts',
              content: `import { catalog } from '../../genie/internal.ts'
export default {
  data: { devDependencies: catalog },
  stringify: () => JSON.stringify({ devDependencies: catalog }),
}
`,
            })

            // Independent success case
            yield* env.writeFile({
              path: 'standalone/package.json.genie.ts',
              content: `export default {
  data: { name: 'standalone' },
  stringify: () => JSON.stringify({ name: 'standalone' }),
}
`,
            })

            // Create parent directories for generated files
            yield* env.writeFile({ path: 'apps/app/.gitkeep', content: '' })
            yield* env.writeFile({ path: 'packages/lib/.gitkeep', content: '' })
            yield* env.writeFile({ path: 'standalone/.gitkeep', content: '' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`

            // Should fail
            expect(exitCode).not.toBe(0)

            // Should show re-validation message
            expect(output).toContain('Re-validating to identify root causes')

            // Should identify root cause (not TDZ errors)
            expect(output).toContain('root cause error')
            expect(output).toContain('Missing required env var DATABASE_URL')

            // Should indicate dependent failures
            expect(output).toContain('failed due to dependency errors')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  it.effect(
    'handles multiple independent root causes',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * When there are multiple independent failures (not dependencies of each other),
             * all should be reported as root causes.
             */

            // First root cause
            yield* env.writeFile({
              path: 'a/package.json.genie.ts',
              content: `throw new Error('Error in module A')
export default { data: {}, stringify: () => '{}' }
`,
            })

            // Second root cause (independent)
            yield* env.writeFile({
              path: 'b/package.json.genie.ts',
              content: `throw new Error('Error in module B')
export default { data: {}, stringify: () => '{}' }
`,
            })

            // Create parent directories
            yield* env.writeFile({ path: 'a/.gitkeep', content: '' })
            yield* env.writeFile({ path: 'b/.gitkeep', content: '' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`

            // Should fail
            expect(exitCode).not.toBe(0)

            // Should show both root causes
            expect(output).toContain('Error in module A')
            expect(output).toContain('Error in module B')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )
})
