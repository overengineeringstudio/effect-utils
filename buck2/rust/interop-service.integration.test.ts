import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Effect } from 'effect'

import { makeRuntime } from '../../packages/@overeng/effect-rust/src/runtime/instance.ts'

const temporaryRoots: string[] = []
const generator = join(import.meta.dir, 'interop-service.ts')
const compiler = resolve(import.meta.dir, '../../packages/@overeng/effect-rust')
const strings = { type: 'array', items: { type: 'string' } }
const lengths = {
  type: 'array',
  items: { type: 'integer', minimum: 0, maximum: 4294967295, 'x-effect-rust-width': 'u32' },
}
type RecordFixture = {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly returns: unknown
  readonly definitions?: Record<string, unknown>
}
const runGenerator = (records: readonly RecordFixture[]) => {
  const root = mkdtempSync(join(tmpdir(), 'interop-service-'))
  temporaryRoots.push(root)
  const product = join(root, 'product')
  const output = join(root, 'service')
  mkdirSync(product)
  writeFileSync(
    join(product, 'exports.json'),
    JSON.stringify({
      version: 1,
      errors: [],
      exports: records.map(({ name, args, returns }, index) => ({
        name,
        rustName: name,
        mode: 'sync',
        args: Object.keys(args).map((argument) => ({ name: argument, type: 'Vec<String>' })),
        returns: returns === null ? 'unit' : 'Vec<u32>',
        error: null,
        schema: `schema${index}`,
      })),
    }),
  )
  writeFileSync(
    join(product, 'index.cjs'),
    records
      .map(
        ({ args, returns, definitions }, index) =>
          `exports.schema${index} = () => ${JSON.stringify(
            JSON.stringify({
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $vocabulary: { 'https://effect-rust.dev/schema/v1': true },
              $defs: definitions ?? {},
              args,
              returns,
            }),
          )};`,
      )
      .join('\n'),
  )
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      generator,
      '--output',
      output,
      '--service',
      'Fixture',
      '--package',
      '@fixture/service',
      '--compiler',
      compiler,
      '--napi',
      product,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { root, output, result }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('interop service inline contracts', () => {
  it('keeps an argument named result distinct from the return codec through a real service call', async () => {
    const { root, output, result } = runGenerator([
      { name: 'lengths', args: { result: strings }, returns: lengths },
    ])
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    mkdirSync(join(root, 'node_modules', '@overeng'), { recursive: true })
    symlinkSync(compiler, join(root, 'node_modules', '@overeng', 'effect-rust'))
    symlinkSync(
      resolve(import.meta.dir, '../../node_modules/effect'),
      join(root, 'node_modules', 'effect'),
    )
    // The generated package lives at a fresh runtime-selected fixture path.
    const { makeFixture } = await import(join(output, 'service.ts'))
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime('fixture', {
          load: () => ({
            api: { lengths: (input: string[]) => input.map((item) => item.length) },
            release: () => undefined,
          }),
        })
        return yield* makeFixture(runtime).lengths(['a', 'three', ''])
      }).pipe(Effect.scoped),
    )
    expect(value).toEqual([1, 5, 0])
  })

  it.each([
    [
      'argument names',
      [{ name: 'lengths', args: { some_value: strings, someValue: lengths }, returns: null }],
      'LengthsInputSomeValue',
    ],
    [
      'export names',
      [
        { name: 'some_export', args: {}, returns: strings },
        { name: 'someExport', args: {}, returns: lengths },
      ],
      'SomeExportOutput',
    ],
  ] as const)(
    'rejects different inline schemas with colliding normalized %s',
    (_label, records, name) => {
      const { output, result } = runGenerator(records)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(
        `Generated contract name ${name} collides between inline schemas`,
      )
      expect(existsSync(output)).toBe(false)
    },
  )

  it.each(['before', 'after'] as const)(
    'rejects a Rust definition discovered %s its synthetic namesake',
    (order) => {
      const inline = { name: 'lengths', args: { result: strings }, returns: null }
      const definition = {
        name: 'defined',
        args: {},
        returns: { $ref: '#/$defs/LengthsInputResult' },
        definitions: { LengthsInputResult: strings },
      }
      const { output, result } = runGenerator(
        order === 'before' ? [definition, inline] : [inline, definition],
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(
        'Generated contract name LengthsInputResult collides with a Rust contract type',
      )
      expect(existsSync(output)).toBe(false)
    },
  )
})
