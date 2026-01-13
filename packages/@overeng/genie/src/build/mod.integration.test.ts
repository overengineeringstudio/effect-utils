import * as crypto from 'node:crypto'
import * as os from 'node:os'
import nodePath from 'node:path'

import { Command, FileSystem, Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Chunk, Effect, Stream } from 'effect'
import { expect } from 'vitest'

type TestEnv = {
  root: string
  writeFile: (args: { path: string; content: string }) => Effect.Effect<void, never>
  symlink: (args: { target: string; path: string }) => Effect.Effect<void, never>
  cleanup: () => Effect.Effect<void, never>
}

const TestLayer = NodeContext.layer

const createTestEnv = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(os.tmpdir(), `genie-cli-test-${crypto.randomBytes(4).toString('hex')}`)

    yield* fs.makeDirectory(root, { recursive: true })

    const writeFile = ({ path: relativePath, content }: { path: string; content: string }) =>
      Effect.gen(function* () {
        const fullPath = path.join(root, relativePath)
        const dir = path.dirname(fullPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(fullPath, content)
      }).pipe(Effect.orDie)

    const symlink = ({ target, path: relativePath }: { target: string; path: string }) =>
      Effect.gen(function* () {
        const targetPath = path.isAbsolute(target) ? target : path.join(root, target)
        const linkPath = path.isAbsolute(relativePath)
          ? relativePath
          : path.join(root, relativePath)
        yield* fs.makeDirectory(path.dirname(linkPath), { recursive: true })
        yield* fs.symlink(targetPath, linkPath)
      }).pipe(Effect.orDie)

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

const runGenie = (env: TestEnv, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
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
    }),
  )

describe('genie cli', () => {
  const withTestEnv = <A, E, R>(fn: (env: TestEnv) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const env = yield* createTestEnv()
      try {
        return yield* fn(env)
      } finally {
        yield* env.cleanup()
      }
    })

  it.effect('reports import errors with clear error message', () =>
    withTestEnv((env) =>
      Effect.gen(function* () {
        yield* env.writeFile({
          path: 'package.json',
          content: JSON.stringify({ name: 'genie-cli-test', private: true }, null, 2),
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
    ).pipe(Effect.provide(TestLayer), Effect.scoped),
  )

  it.effect('skips symlinked directories that resolve inside the root', () =>
    withTestEnv((env) =>
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
    ).pipe(Effect.provide(TestLayer), Effect.scoped),
  )
})
