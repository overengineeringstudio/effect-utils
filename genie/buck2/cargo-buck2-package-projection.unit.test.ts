import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('rejects injectable Buck labels and generated comments', () => {
    expect(() =>
      defineCargoBuck2PackageProjection({
        ...consumerProjectionOptions,
        buck2LoadLabelPrefix: '@rules//buck2")\nmalicious_rule(',
      }),
    ).toThrow('buck2LoadLabelPrefix is not a Buck cell/package prefix')
    expect(() =>
      defineCargoBuck2PackageProjection({
        ...consumerProjectionOptions,
        regenerationCommand: 'devenv tasks run genie:run\nmalicious_rule()',
      }),
    ).toThrow('regenerationCommand must be a single line')
  })

  it('binds the third-party label to the validated local graph', () => {
    for (const thirdPartyPackage of ['@other//vendor/cargo', '//vendor/other']) {
      expect(() =>
        defineCargoBuck2PackageProjection({
          ...consumerProjectionOptions,
          thirdPartyPackage,
        }),
      ).toThrow(
        'thirdPartyPackage must be the repository-local package containing thirdPartyBuckPath',
      )
    }
  })

  it('binds the graph path to Reindeer and rejects control characters', () => {
    const mismatchedConfig = path.join(fixtureRoot, 'components/rust/mismatch-reindeer.toml')
    writeFileSync(mismatchedConfig, 'vendor = false\nthird_party_dir = "."\n')
    try {
      expect(() =>
        defineCargoBuck2PackageProjection({
          ...consumerProjectionOptions,
          reindeerConfigPath: 'components/rust/mismatch-reindeer.toml',
        }),
      ).toThrow('thirdPartyBuckPath must match reindeer.toml third_party_dir')
    } finally {
      rmSync(mismatchedConfig, { force: true })
    }
    expect(() =>
      defineCargoBuck2PackageProjection({
        ...consumerProjectionOptions,
        cargoLockPath: 'components/rust/Cargo.lock\n# injected',
      }),
    ).toThrow('cargoLockPath must be a normalized repository-relative path')
  })
})

type CargoFixtureMember = {
  readonly manifest: string
  readonly files: readonly string[]
}

/** Render one member of a throwaway `rust/` Cargo workspace through the projector. */
const renderCargoFixture = ({
  members,
  workspaceDependencies = '',
  render,
}: {
  readonly members: Readonly<Record<string, CargoFixtureMember>>
  readonly workspaceDependencies?: string
  readonly render: string
}): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'cargo-projection-discovery-'))
  const write = (relativePath: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
    writeFileSync(path.join(root, relativePath), content)
  }
  try {
    write('megarepo.kdl', '')
    write(
      'rust/Cargo.toml',
      `[workspace]\nresolver = "2"\nmembers = [${Object.keys(members)
        .map((member) => JSON.stringify(member))
        .join(
          ', ',
        )}]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n[workspace.dependencies]\nserde = "1"\n${workspaceDependencies}`,
    )
    write(
      'rust/Cargo.lock',
      'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    )
    write('rust/reindeer.toml', 'vendor = false\nthird_party_dir = "third-party"\n')
    write('rust/third-party/BUCK', 'alias(\n    name = "serde",\n    actual = ":serde-1.0.0",\n)\n')
    for (const [memberPath, member] of Object.entries(members)) {
      const [header, ...rest] = member.manifest.split('\n[')
      write(
        `rust/${memberPath}/Cargo.toml`,
        [
          `${header}\nversion.workspace = true\nedition.workspace = true\nworkspace = "${memberPath
            .split('/')
            .map(() => '..')
            .join('/')}"\n`,
          ...rest.map((section) => `[${section}`),
        ].join('\n'),
      )
      for (const file of member.files) write(`rust/${memberPath}/${file}`, '// fixture\n')
      write(`rust/${memberPath}/BUCK.genie.ts`, '// Runtime-only projection fixture.\n')
    }
    const project = defineCargoBuck2PackageProjection({
      repoName: 'discovery-fixture',
      repoImportMetaUrl: pathToFileURL(path.join(root, 'projection.ts')).href,
      workspaceRoot: 'rust',
      workspaceMemberManifestPaths: Object.keys(members).map(
        (memberPath) => `rust/${memberPath}/Cargo.toml`,
      ),
      generatorSourcePaths: [],
    })
    return project({
      sourceUrl: pathToFileURL(path.join(root, 'rust', render, 'BUCK.genie.ts')).href,
    }).stringify({ cwd: root, location: '' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The rendered `native.*` rule blocks keyed by target name. */
const renderedRules = (rendered: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    [
      ...rendered.matchAll(
        /^native\.(rust_library|rust_binary)\(\n {4}name = "([^"]+)",\n([\s\S]*?)^\)$/gm,
      ),
    ].map((match) => [match[2], `${match[1]}\n${match[3]}`]),
  )

describe('Cargo target discovery', () => {
  it('discovers src/lib.rs, src/main.rs, src/bin/*.rs, and src/bin/<name>/main.rs', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          'my-tool': {
            manifest: '[package]\nname = "my-tool"',
            files: [
              'src/lib.rs',
              'src/util.rs',
              'src/main.rs',
              'src/bin/extra.rs',
              'src/bin/multi/main.rs',
              'src/bin/multi/args.rs',
            ],
          },
        },
        render: 'my-tool',
      }),
    )
    expect(Object.keys(rules)).toEqual(['lib', 'extra', 'multi', 'my-tool'])
    expect(rules.lib).toContain('crate = "my_tool",\n    crate_root = "src/lib.rs",')
    expect(rules.lib).toContain('srcs = [\n        "src/lib.rs",\n        "src/util.rs",\n    ],')
    expect(rules['my-tool']).toContain('crate = "my_tool",\n    crate_root = "src/main.rs",')
    expect(rules['my-tool']).toContain('deps = [\n        ":lib",\n    ],')
    expect(rules.extra).toContain(
      'crate_root = "src/bin/extra.rs",\n    srcs = [\n        "src/bin/extra.rs",\n    ],',
    )
    expect(rules.multi).toContain(
      'crate_root = "src/bin/multi/main.rs",\n    srcs = [\n        "src/bin/multi/args.rs",\n        "src/bin/multi/main.rs",\n    ],',
    )
  })

  it('names empty and path-only [lib] tables after the package', () => {
    const emptyLib = renderedRules(
      renderCargoFixture({
        members: {
          'cli-version': {
            manifest: '[package]\nname = "cli-version"\n\n[lib]',
            files: ['src/lib.rs'],
          },
        },
        render: 'cli-version',
      }),
    )
    expect(emptyLib.lib).toContain('crate = "cli_version",\n    crate_root = "src/lib.rs",')
    const pathOnlyLib = renderedRules(
      renderCargoFixture({
        members: {
          'nix-trace': {
            manifest: '[package]\nname = "nix-trace"\n\n[lib]\npath = "src/trace.rs"',
            files: ['src/trace.rs', 'src/main.rs'],
          },
        },
        render: 'nix-trace',
      }),
    )
    expect(Object.keys(pathOnlyLib)).toEqual(['lib', 'nix-trace'])
    expect(pathOnlyLib.lib).toContain('crate = "nix_trace",\n    crate_root = "src/trace.rs",')
  })

  it('honors autolib and autobins = false and infers explicit binary paths', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          quiet: {
            manifest:
              '[package]\nname = "quiet"\nautolib = false\nautobins = false\n\n[[bin]]\nname = "chosen"',
            files: ['src/lib.rs', 'src/main.rs', 'src/bin/chosen.rs', 'src/bin/ignored.rs'],
          },
        },
        render: 'quiet',
      }),
    )
    expect(Object.keys(rules)).toEqual(['chosen'])
    expect(rules.chosen).toContain('crate_root = "src/bin/chosen.rs",')
    expect(rules.chosen).toContain('deps = [\n    ],')
  })

  it('lets an explicit binary replace the inferred target of the same name', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          app: {
            manifest: '[package]\nname = "app"\n\n[[bin]]\nname = "app"\npath = "src/cli.rs"',
            files: ['src/cli.rs', 'src/main.rs', 'src/bin/helper.rs'],
          },
        },
        render: 'app',
      }),
    )
    expect(Object.keys(rules)).toEqual(['app', 'helper'])
    expect(rules.app).toContain('crate_root = "src/cli.rs",')
  })

  it('rejects conflicting, ambiguous, missing, and absent targets', () => {
    const renderSingle = (manifest: string, files: readonly string[]) =>
      renderCargoFixture({
        members: { pkg: { manifest: `[package]\nname = "pkg"${manifest}`, files } },
        render: 'pkg',
      })
    expect(() => renderSingle('\n\n[lib]\npath = "src/main.rs"', ['src/main.rs'])).toThrow(
      'Cargo targets share a crate root in rust/pkg/Cargo.toml: src/main.rs',
    )
    expect(() =>
      renderSingle('\n\n[[bin]]\nname = "other"\npath = "src/lib.rs"', ['src/lib.rs']),
    ).toThrow('Cargo targets share a crate root')
    expect(() => renderSingle('', ['src/bin/twin.rs', 'src/bin/twin/main.rs'])).toThrow(
      'Cargo binary target discovery is ambiguous in rust/pkg/Cargo.toml: twin',
    )
    expect(() => renderSingle('', ['src/main.rs', 'src/bin/pkg.rs'])).toThrow(
      'Cargo binary target discovery is ambiguous in rust/pkg/Cargo.toml: pkg',
    )
    expect(() => renderSingle('\n\n[lib]', ['src/main.rs'])).toThrow(
      'Cargo [lib] without path needs src/lib.rs in rust/pkg/Cargo.toml',
    )
    expect(() => renderSingle('\n\n[[bin]]\nname = "ghost"', ['src/lib.rs'])).toThrow(
      'bin[0].path (no src/bin/ghost.rs, src/bin/ghost/main.rs, or src/main.rs for the package binary)',
    )
    expect(() =>
      renderSingle('\nautolib = false\nautobins = false', ['src/lib.rs', 'src/main.rs']),
    ).toThrow('Cargo package rust/pkg has no library or binary target')
    expect(() => renderSingle('\nautobins = "no"', ['src/main.rs'])).toThrow(
      'Cargo autobins must be a boolean in rust/pkg/Cargo.toml',
    )
  })
})

describe('Cargo workspace path dependencies', () => {
  it('resolves [workspace.dependencies] path entries inherited with workspace = true', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          'crates/core': { manifest: '[package]\nname = "core"', files: ['src/lib.rs'] },
          'crates/app': {
            manifest:
              '[package]\nname = "app"\n\n[dependencies]\ncore = { workspace = true }\nserde.workspace = true',
            files: ['src/main.rs'],
          },
        },
        workspaceDependencies: 'core = { path = "crates/core" }\n',
        render: 'crates/app',
      }),
    )
    expect(rules.app).toContain(
      'deps = [\n        "//rust/crates/core:lib",\n        "//rust/third-party:serde",\n    ],',
    )
  })

  it('rejects inherited paths outside the workspace or without a library', () => {
    expect(() =>
      renderCargoFixture({
        members: {
          'crates/app': {
            manifest: '[package]\nname = "app"\n\n[dependencies]\nghost.workspace = true',
            files: ['src/main.rs'],
          },
        },
        workspaceDependencies: 'ghost = { path = "crates/ghost" }\n',
        render: 'crates/app',
      }),
    ).toThrow(
      'Cargo path dependency at dependencies.ghost is not a workspace member: rust/crates/ghost',
    )
    expect(() =>
      renderCargoFixture({
        members: {
          'crates/tool': { manifest: '[package]\nname = "tool"', files: ['src/main.rs'] },
          'crates/app': {
            manifest: '[package]\nname = "app"\n\n[dependencies]\ntool.workspace = true',
            files: ['src/main.rs'],
          },
        },
        workspaceDependencies: 'tool = { path = "crates/tool" }\n',
        render: 'crates/app',
      }),
    ).toThrow(
      'Cargo path dependency at dependencies.tool does not expose the contracted :lib target',
    )
  })
})
