import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { makeOxfmtFormatter } from './generation.ts'

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const withFormatterTest = <TOutput, TError, TRequirements>(
  effect: Effect.Effect<TOutput, TError, TRequirements>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe('per-check formatter config reuse', () => {
  it.effect(
    'shares concurrent preflight reads and preserves fresh CLI output for every supported extension',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'genie-formatter-' })
        const configPath = `${root}/oxfmt.json`
        yield* fs.writeFileString(
          configPath,
          '{"printWidth":1,"tabWidth":4,"overrides":[{"files":["*.yaml"],"options":{"tabWidth":2}}]}',
        )
        let reads = 0
        const countedFs = {
          ...fs,
          readFileString: (...args: Parameters<typeof fs.readFileString>) => {
            if (args[0] === configPath) reads += 1
            return fs.readFileString(...args)
          },
        }
        const fixtures = [
          { targetFilePath: `${root}/data.json`, content: '{"nested":{"value":1}}' },
          { targetFilePath: `${root}/data.jsonc`, content: '// comment\n{"nested":{"value":1}}' },
          { targetFilePath: `${root}/data.yml`, content: 'nested: {value: 1}\n' },
          { targetFilePath: `${root}/data.yaml`, content: 'nested: {value: 1}\n' },
          // The CLI's parse failure/empty-output behavior must still return the input.
          { targetFilePath: `${root}/invalid.json`, content: '{ definitely not json' },
        ]
        const shared = yield* makeOxfmtFormatter({ configPath: Option.some(configPath) }).pipe(
          Effect.provideService(FileSystem.FileSystem, countedFs),
        )
        const actual = yield* Effect.forEach(fixtures, shared, { concurrency: 'unbounded' }).pipe(
          Effect.provideService(FileSystem.FileSystem, countedFs),
        )
        expect(reads).toBe(1)
        const expected = yield* Effect.forEach(fixtures, (fixture) =>
          Effect.gen(function* () {
            const fresh = yield* makeOxfmtFormatter({ configPath: Option.some(configPath) })
            return yield* fresh(fixture)
          }),
        )
        expect(actual).toEqual(expected)
        expect(actual[0]).toBe('{\n    "nested": {\n        "value": 1\n    }\n}\n')
        expect(actual[4]).toBe(fixtures[4]!.content)
      }).pipe(withFormatterTest),
  )

  it.effect('reloads changed and previously invalid config on each execution of the factory', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'genie-formatter-' })
      const configPath = `${root}/oxfmt.json`
      const makeFormatter = makeOxfmtFormatter({ configPath: Option.some(configPath) })
      const fixture = { targetFilePath: `${root}/data.json`, content: '{"value":1}' }
      yield* fs.writeFileString(configPath, '{"printWidth":1,"tabWidth":2}')
      const first = yield* makeFormatter
      expect(yield* first(fixture)).toBe('{\n  "value": 1\n}\n')
      yield* fs.writeFileString(configPath, '{"printWidth":1,"tabWidth":4}')
      const second = yield* makeFormatter
      expect(yield* second(fixture)).toBe('{\n    "value": 1\n}\n')
      yield* fs.writeFileString(configPath, 'not json')
      const invalid = yield* makeFormatter
      expect(yield* invalid(fixture)).toBe(fixture.content)
      yield* fs.writeFileString(configPath, '{"printWidth":1,"tabWidth":2}')
      const repaired = yield* makeFormatter
      expect(yield* repaired(fixture)).toBe('{\n  "value": 1\n}\n')
      yield* fs.remove(configPath)
      const missing = yield* makeFormatter
      expect(yield* missing(fixture)).toBe(fixture.content)
    }).pipe(withFormatterTest),
  )

  for (const initialConfig of ['invalid', 'missing'] as const) {
    it.effect(`retries ${initialConfig} config after repair within the same check`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'genie-formatter-' })
        const configPath = `${root}/oxfmt.json`
        if (initialConfig === 'invalid') yield* fs.writeFileString(configPath, 'not json')
        let reads = 0
        const countedFs = {
          ...fs,
          readFileString: (...args: Parameters<typeof fs.readFileString>) => {
            if (args[0] === configPath) reads += 1
            return fs.readFileString(...args)
          },
        }
        const formatter = yield* makeOxfmtFormatter({ configPath: Option.some(configPath) })
        const content = '{"value":1}'
        expect(
          yield* formatter({ targetFilePath: `${root}/first.json`, content }).pipe(
            Effect.provideService(FileSystem.FileSystem, countedFs),
          ),
        ).toBe(content)
        yield* fs.writeFileString(configPath, '{"printWidth":1,"tabWidth":4}')
        for (const file of ['second.json', 'third.json']) {
          expect(
            yield* formatter({ targetFilePath: `${root}/${file}`, content }).pipe(
              Effect.provideService(FileSystem.FileSystem, countedFs),
            ),
          ).toBe('{\n    "value": 1\n}\n')
        }
        expect(reads).toBe(2)
      }).pipe(withFormatterTest),
    )
  }

  it.effect('does not read config for unsupported targets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'genie-formatter-' })
      const configPath = `${root}/missing.json`
      let reads = 0
      const formatter = yield* makeOxfmtFormatter({ configPath: Option.some(configPath) })
      const fixture = { targetFilePath: `${root}/BUCK`, content: 'unformatted output\n' }
      const actual = yield* formatter(fixture).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (...args: Parameters<typeof fs.readFileString>) => {
            reads += 1
            return fs.readFileString(...args)
          },
        }),
      )
      expect(actual).toBe(fixture.content)
      expect(reads).toBe(0)
    }).pipe(withFormatterTest),
  )
})

describe('formatter subprocess stdin lifetime', () => {
  it.effect('keeps early formatter exits from escaping as an unhandled EPIPE', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'genie-formatter-exit-' })
      const formatterModule = new URL('./generation.ts', import.meta.url).href
      const source = `
import { symlinkSync } from 'node:fs'
import { NodeServices } from '@effect/platform-node'
import { Effect, Option } from 'effect'
import { makeOxfmtFormatter } from ${encodeString(formatterModule)}
// A native early exit forces stdin to close before buffered input is flushed.
symlinkSync(Bun.which('true')!, ${encodeString(`${root}/oxfmt`)})
await Effect.runPromise(Effect.gen(function* () {
  const formatter = yield* makeOxfmtFormatter({ configPath: Option.none() })
  for (let iteration = 0; iteration < 500; iteration++) {
    const content = '{"violations":[]}\\n'
    const result = yield* formatter({ targetFilePath: ${encodeString(`${root}/ledger.json`)}, content })
    if (result !== content) throw new Error('Formatter fallback changed the content')
  }
}).pipe(Effect.provide(NodeServices.layer)))
`
      // Isolate unhandled stream errors: the child must exit cleanly, not merely
      // resolve the formatting Effect before a late Writable error is emitted.
      const result = spawnSync('bun', ['--eval', source], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      })
      const stderr = result.stderr
      expect(result.status, stderr).toBe(0)
      expect(stderr).not.toContain('EPIPE')
    }).pipe(withFormatterTest),
  )
})
