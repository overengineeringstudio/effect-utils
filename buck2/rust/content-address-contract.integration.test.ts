import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { cargoBuck2WorkspaceMemberPaths } from '../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const repoRoot = resolve(import.meta.dir, '../..')
const generator = 'packages/@overeng/content-address/src/generate-contract.ts'
const contract = 'rust/content-address-contract'
const compiledArtifacts = ['src/lib.rs', 'Cargo.toml'] as const

/** Exercise the real writer and package projectors without modifying the checkout. */
const makeFixture = (): string => {
  const temporaryRoot = join(repoRoot, 'tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const root = mkdtempSync(join(temporaryRoot, 'content-address-provenance-'))
  const copy = (path: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(repoRoot, path), join(root, path), {
      recursive: true,
      filter: (source) =>
        !source
          .split('/')
          .some((part) =>
            ['node_modules', 'dist', 'target', 'buck-out', '.devenv', 'test-results'].includes(
              part,
            ),
          ),
    })
  }
  for (const path of [
    'megarepo.kdl',
    'pnpm-lock.yaml',
    'flake.lock',
    'genie/buck2/mod.ts',
    'packages/@overeng/genie/src/runtime',
    'packages/@overeng/effect-rust/src',
    'packages/@overeng/effect-rust/package.json',
    generator,
    'packages/@overeng/content-address/src/schema.ts',
    'packages/@overeng/work-storage/protocol.schema.json',
    'packages/@overeng/work-storage/fixtures/conformance.json',
    'rust',
    ...cargoBuck2WorkspaceMemberPaths.filter((path) => !path.startsWith('rust/')),
  ])
    copy(path)

  // The fixture uses the selected runtime packages, but resolves the compiler
  // workspace link to its own copied source, never an installed workspace snapshot.
  mkdirSync(join(root, 'node_modules/@overeng'), { recursive: true })
  mkdirSync(join(root, 'node_modules/@effect'), { recursive: true })
  for (const name of ['effect', '@effect/platform-node'])
    symlinkSync(join(repoRoot, 'node_modules', name), join(root, 'node_modules', name))
  symlinkSync(
    join(root, 'packages/@overeng/effect-rust'),
    join(root, 'node_modules/@overeng/effect-rust'),
  )
  return root
}

const run = (root: string, args: readonly string[]) => {
  // Contract fingerprints record the published runtime, not this test runner's.
  const bun = args[0] === generator ? process.env.BUN_BIN : process.execPath
  if (bun === undefined || bun === '')
    throw new Error('Contract generator tests require BUN_BIN from buck2:rust:generators:test')
  return Bun.spawnSync({ cmd: [bun, ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' })
}

const succeed = (root: string, args: readonly string[]): string => {
  const result = run(root, args)
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

const freshnessArgs = [
  '-e',
  `import { assertContractGenerationFreshness } from './${contract}/generation-freshness.ts';
assertContractGenerationFreshness({ sourceUrl: new URL('./${contract}/BUCK.genie.ts', import.meta.url).href });`,
] as const

const projectArgs = [
  '-e',
  `import { cargoBuck2WorkspaceMemberPaths } from './rust/buck2-tools/core/cargo-buck2-package-projection.ts';
const outputs = {};
for (const path of cargoBuck2WorkspaceMemberPaths) {
  const projection = (await import('./' + path + '/BUCK.genie.ts')).default;
  outputs[path] = projection.stringify({ cwd: process.cwd(), location: path });
}
console.log(JSON.stringify(outputs));`,
] as const

describe('content-address contract provenance', () => {
  it('keeps compiled bytes and every workspace BUCK projection stable across a lockfile-only change', () => {
    const root = makeFixture()
    try {
      succeed(root, [generator])
      succeed(root, [generator, '--check'])
      succeed(root, freshnessArgs)
      const before = compiledArtifacts.map((path) =>
        readFileSync(join(root, contract, path), 'utf8'),
      )
      for (const content of before) {
        expect(content).toContain('Generated contract; DO NOT EDIT BY HAND.')
        expect(content).toContain(`Provenance: ${contract}/generation.json`)
        expect(content).toContain(`Regenerate: bun ${generator}`)
        expect(content).not.toContain('Input fingerprint:')
        expect(content).not.toContain('Generated at:')
      }
      const manifestBefore = readFileSync(join(root, contract, 'generation.json'), 'utf8')
      const projectionsBefore = succeed(root, projectArgs)

      // A pure lockfile byte change must invalidate provenance, but not the
      // contract content or any Cargo workspace projection's semantic header.
      const lockfile = join(root, 'pnpm-lock.yaml')
      writeFileSync(
        lockfile,
        `${readFileSync(lockfile, 'utf8')}\n# Unrelated JavaScript lockfile update.\n`,
      )
      const staleInput = run(root, freshnessArgs)
      expect(staleInput.exitCode).not.toBe(0)
      expect(staleInput.stderr.toString()).toContain('input hash mismatch: pnpm-lock.yaml')

      succeed(root, [generator])
      succeed(root, [generator, '--check'])
      succeed(root, freshnessArgs)
      expect(readFileSync(join(root, contract, 'generation.json'), 'utf8')).not.toBe(manifestBefore)
      expect(
        compiledArtifacts.map((path) => readFileSync(join(root, contract, path), 'utf8')),
      ).toEqual(before)
      expect(succeed(root, projectArgs)).toBe(projectionsBefore)

      // The artifact-byte check remains independent of input freshness.
      const rust = join(root, contract, 'src/lib.rs')
      chmodSync(rust, 0o644)
      writeFileSync(rust, `${before[0]}\n// Unrecorded generated artifact edit.\n`)
      const staleArtifact = run(root, freshnessArgs)
      expect(staleArtifact.exitCode).not.toBe(0)
      expect(staleArtifact.stderr.toString()).toContain('artifact hash mismatch: src/lib.rs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('changes compiled contract bytes after a semantic schema input change', () => {
    const root = makeFixture()
    try {
      succeed(root, [generator])
      const rust = join(root, contract, 'src/lib.rs')
      const before = readFileSync(rust, 'utf8')
      expect(before).not.toContain('pub semantic_control: String,')

      const schemaPath = 'packages/@overeng/content-address/src/schema.ts'
      const schema = join(root, schemaPath)
      const source = readFileSync(schema, 'utf8')
      const changed = source.replace(
        "export const ContentDescriptor = Schema.TaggedStruct('ContentDescriptor', {",
        "export const ContentDescriptor = Schema.TaggedStruct('ContentDescriptor', {\n  semanticControl: Schema.String,",
      )
      expect(changed).not.toBe(source)
      writeFileSync(schema, changed)

      const staleInput = run(root, freshnessArgs)
      expect(staleInput.exitCode).not.toBe(0)
      expect(staleInput.stderr.toString()).toContain(`input hash mismatch: ${schemaPath}`)
      expect(run(root, [generator, '--check']).exitCode).not.toBe(0)

      succeed(root, [generator])
      succeed(root, [generator, '--check'])
      succeed(root, freshnessArgs)
      const after = readFileSync(rust, 'utf8')
      expect(after).not.toBe(before)
      expect(after).toContain('pub semantic_control: String,')
      expect(after).toContain('#[serde(rename = "semanticControl",')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
