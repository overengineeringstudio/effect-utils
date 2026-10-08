import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryRoots: string[] = []
const packager = process.env.BUCK2_WASM_PACKAGER ?? join(import.meta.dir, 'wasm-guest-package.ts')

// A real core module with env.base imported, plus function, table, memory and global exports.
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes]
const exportEntry = (name: string, kind: number, index: number) => [
  name.length,
  ...Buffer.from(name),
  kind,
  index,
]
const moduleBytes = Buffer.from([
  0,
  0x61,
  0x73,
  0x6d,
  1,
  0,
  0,
  0,
  ...section(1, [1, 0x60, 0, 1, 0x7f]),
  ...section(2, [1, 3, ...Buffer.from('env'), 4, ...Buffer.from('base'), 3, 0x7f, 0]),
  ...section(3, [1, 0]),
  ...section(4, [1, 0x70, 0, 1]),
  ...section(5, [1, 0, 1]),
  ...section(6, [1, 0x7f, 0, 0x41, 7, 0x0b]),
  ...section(7, [
    5,
    ...exportEntry('zeta', 0, 0),
    ...exportEntry('answer', 0, 0),
    ...exportEntry('memory', 2, 0),
    ...exportEntry('table', 1, 0),
    ...exportEntry('global', 3, 1),
  ]),
  ...section(10, [1, 4, 0, 0x41, 42, 0x0b]),
])

const runAction = (entrypoint: string) => {
  const root = mkdtempSync(join(tmpdir(), 'wasm-guest-package-'))
  temporaryRoots.push(root)
  const input = join(root, 'guest.wasm')
  const provenance = join(root, 'provenance.json')
  const payload = join(root, 'artifact.tar')
  const descriptor = join(root, 'descriptor.json')
  writeFileSync(input, moduleBytes)
  writeFileSync(provenance, JSON.stringify({ recipe: 'fixture/v1', toolchain: 'fixture/v1' }))
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      packager,
      '--input',
      input,
      '--provenance',
      provenance,
      '--entrypoint',
      entrypoint,
      '--name',
      'fixture-guest',
      '--harness',
      'fixture-harness/v1',
      '--target',
      '//fixtures:guest',
      '--payload',
      payload,
      '--descriptor',
      descriptor,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { root, payload, descriptor, result }
}

const tar = (args: string[]) => {
  const result = Bun.spawnSync({ cmd: ['tar', ...args], stdout: 'pipe', stderr: 'pipe' })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('wasm guest packager action', () => {
  it.each([
    ['120-byte nested path', `lib/${'a'.repeat(105)}/guest.wasm`],
    ['120-byte UTF-8 nested path', `lib/${'é'.repeat(52)}x/guest.wasm`],
    ['100-byte name boundary', 'a'.repeat(100)],
    ['155-byte prefix and 100-byte name boundaries', `${'a'.repeat(155)}/${'b'.repeat(100)}`],
  ])(
    'round-trips the complete %s through real tar listing and extraction',
    (_label, entrypoint) => {
      const { root, payload, result } = runAction(entrypoint)
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      expect(tar(['--list', '--file', payload])).toBe(`${entrypoint}\n`)
      const extracted = join(root, 'extracted')
      mkdirSync(extracted)
      tar(['--extract', '--file', payload, '--directory', extracted])
      expect(readFileSync(join(extracted, entrypoint))).toEqual(moduleBytes)
    },
  )

  it.each([
    ['120-byte unsplittable name', 'a'.repeat(120)],
    ['120-byte UTF-8 unsplittable name', 'é'.repeat(60)],
    ['overlong prefix', `${'a'.repeat(156)}/guest.wasm`],
  ])('rejects the %s before writing any artifact', (_label, entrypoint) => {
    const { payload, descriptor, result } = runAction(entrypoint)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(
      'wasm guest entrypoint cannot be represented in USTAR',
    )
    expect(existsSync(payload)).toBe(false)
    expect(existsSync(descriptor)).toBe(false)
  })

  it('binds the complete sorted export ABI and preserves module imports', () => {
    const { root, payload, descriptor, result } = runAction('lib/guest.wasm')
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    const product = JSON.parse(readFileSync(descriptor, 'utf8'))
    expect(product.runtime.imports).toEqual(['env.base'])
    expect(product.runtime.exports).toEqual([
      { name: 'answer', kind: 'function' },
      { name: 'global', kind: 'global' },
      { name: 'memory', kind: 'memory' },
      { name: 'table', kind: 'table' },
      { name: 'zeta', kind: 'function' },
    ])
    const extracted = join(root, 'extracted')
    mkdirSync(extracted)
    tar(['--extract', '--file', payload, '--directory', extracted])
    const guest = new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(join(extracted, 'lib/guest.wasm'))),
      { env: { base: 0 } },
    )
    const answer = guest.exports.answer
    if (typeof answer !== 'function') throw new Error('packaged answer export is not a function')
    expect(answer()).toBe(42)
  })
})
