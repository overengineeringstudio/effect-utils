import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { GenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import otelScrapeBuck from '../../packages/@overeng/otel-scrape/BUCK.genie.ts'
import oteliteBuck from '../../packages/@overeng/otelite/BUCK.genie.ts'
import archiveToolBuck from '../../rust/buck2-tools/archive-tool/BUCK.genie.ts'
import coreBuck from '../../rust/buck2-tools/core/BUCK.genie.ts'
import { defineCargoBuck2PackageProjection } from '../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'
import productBuck from '../../rust/buck2-tools/product/BUCK.genie.ts'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const fixtureRoot = fileURLToPath(new URL('./fixtures/cargo-consumer/', import.meta.url))
const genieContext = { cwd: repoRoot, location: '' }
const consumerProjectionOptions = {
  repoName: 'consumer-fixture',
  repoImportMetaUrl: pathToFileURL(path.join(fixtureRoot, 'projection.ts')).href,
  workspaceRoot: 'components/rust',
  cargoManifestPath: 'components/rust/Cargo.toml',
  cargoLockPath: 'components/rust/Cargo.lock',
  reindeerConfigPath: 'components/rust/reindeer.toml',
  workspaceMemberManifestPaths: ['components/rust/consumer-cli/Cargo.toml'],
  thirdPartyBuckPath: 'vendor/cargo/BUCK',
  thirdPartyPackage: '//vendor/cargo',
  buck2LoadLabelPrefix: '@rules//buck2',
  generatorSourcePaths: [],
} as const

const effectUtilsProjections: readonly {
  readonly output: GenieOutput<unknown>
  readonly path: string
}[] = [
  { output: otelScrapeBuck, path: 'packages/@overeng/otel-scrape/BUCK' },
  { output: oteliteBuck, path: 'packages/@overeng/otelite/BUCK' },
  { output: archiveToolBuck, path: 'rust/buck2-tools/archive-tool/BUCK' },
  { output: coreBuck, path: 'rust/buck2-tools/core/BUCK' },
  { output: productBuck, path: 'rust/buck2-tools/product/BUCK' },
]

describe('Cargo Buck2 package projection', () => {
  it('keeps every effect-utils default projection byte-identical', () => {
    for (const projection of effectUtilsProjections) {
      expect(
        `# Generated file - DO NOT EDIT\n# Source: BUCK.genie.ts\n\n${projection.output.stringify(genieContext)}`,
      ).toBe(readFileSync(path.join(repoRoot, projection.path), 'utf8'))
    }
  })

  it('renders a consumer workspace through the rules cell', () => {
    const projectionSource = path.join(fixtureRoot, 'components/rust/consumer-cli/BUCK.genie.ts')
    writeFileSync(projectionSource, '// Runtime-only projection fixture.\n')
    try {
      const project = defineCargoBuck2PackageProjection(consumerProjectionOptions)
      const output = project({
        buildProduct: true,
        sourceUrl: pathToFileURL(projectionSource).href,
      })
      expect(output.stringify(genieContext)).toBe(
        readFileSync(path.join(fixtureRoot, 'expected.BUCK'), 'utf8'),
      )
    } finally {
      rmSync(projectionSource, { force: true })
    }
  })

  it('rejects lexical and physical repository escapes', () => {
    expect(() =>
      defineCargoBuck2PackageProjection({
        ...consumerProjectionOptions,
        cargoManifestPath: '../Cargo.toml',
      }),
    ).toThrow('cargoManifestPath must be a normalized repository-relative path')

    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'cargo-projection-'))
    const outsideManifest = path.join(outsideRoot, 'Cargo.toml')
    const linkedManifest = path.join(fixtureRoot, 'escape-Cargo.toml')
    writeFileSync(outsideManifest, '[workspace]\nresolver = "2"\nmembers = []\n')
    symlinkSync(outsideManifest, linkedManifest)
    try {
      expect(() =>
        defineCargoBuck2PackageProjection({
          ...consumerProjectionOptions,
          cargoManifestPath: 'escape-Cargo.toml',
        }),
      ).toThrow('cargoManifestPath resolves outside the repository')
    } finally {
      rmSync(linkedManifest, { force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})
