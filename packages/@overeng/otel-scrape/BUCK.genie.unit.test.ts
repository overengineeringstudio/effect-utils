import { describe, expect, it } from 'vitest'

import { cargoDependencyLabel, resolveCargoTargetMetadata } from './BUCK.genie.ts'

const manifest = {
  package: {
    name: 'otel-scrape',
    workspace: '../../../rust',
    version: { workspace: true },
    edition: { workspace: true },
  },
  lib: { name: 'otel_scrape', path: 'src/lib.rs' },
  bin: [{ name: 'otel-scrape', path: 'src/main.rs' }],
} as const
const workspace = { workspace: { package: { version: '0.0.0', edition: '2021' } } } as const

describe('OTEL Cargo-to-Buck target projection', () => {
  it('resolves the supported package, library, binary, edition, and version', () => {
    expect(resolveCargoTargetMetadata({ manifest, workspace })).toEqual({
      binaryName: 'otel-scrape',
      binaryPath: 'src/main.rs',
      edition: '2021',
      libraryName: 'otel_scrape',
      libraryPath: 'src/lib.rs',
      packageName: 'otel-scrape',
      version: '0.0.0',
    })
  })

  it.each([
    [
      'multiple binaries',
      { ...manifest, bin: [...manifest.bin, { name: 'other', path: 'src/other.rs' }] },
    ],
    ['build script', { ...manifest, package: { ...manifest.package, build: 'build.rs' } }],
    ['build dependencies', { ...manifest, 'build-dependencies': { cc: '1' } }],
    ['target dependencies', { ...manifest, target: { cfg: {} } }],
    ['features', { ...manifest, features: { default: [] } }],
    [
      'binary required-features',
      { ...manifest, bin: [{ ...manifest.bin[0], 'required-features': ['cli'] }] },
    ],
  ])('rejects unsupported %s', (_label, candidate) => {
    expect(() => resolveCargoTargetMetadata({ manifest: candidate, workspace })).toThrow(
      /not supported|Exactly one/u,
    )
  })

  it('rejects Cargo implicit build.rs convention', () => {
    expect(() =>
      resolveCargoTargetMetadata({ defaultBuildScriptExists: true, manifest, workspace }),
    ).toThrow('Cargo build scripts are not supported')
  })

  it('rejects renamed dependencies instead of silently changing Cargo semantics', () => {
    expect(() => cargoDependencyLabel(['alias', { package: 'real-package' }])).toThrow(
      'Unsupported renamed Cargo dependency',
    )
  })

  it('rejects optional dependencies instead of projecting them unconditionally', () => {
    expect(() => cargoDependencyLabel(['serde', { workspace: true, optional: true }])).toThrow(
      'Unsupported optional Cargo dependency',
    )
  })
})
