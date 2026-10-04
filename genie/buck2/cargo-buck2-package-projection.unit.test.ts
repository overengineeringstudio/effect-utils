import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  type CargoBuck2PackageProjectionOptions,
  defineCargoBuck2PackageProjection,
} from '../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

const fixtureRoot = fileURLToPath(new URL('./fixtures/cargo-consumer/', import.meta.url))
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

describe('Cargo Buck2 package projection', () => {
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
    writeFileSync(mismatchedConfig, 'vendor = false\ncargo_env = true\nthird_party_dir = "."\n')
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

/**
 * Render one member of a throwaway `rust/` Cargo workspace through the projector. Member `.`
 * is the workspace root package, declared in `rust/Cargo.toml` itself.
 */
const renderCargoFixture = ({
  members,
  edition = '2024',
  workspaceVersion = '0.1.0',
  workspacePackageFields = '',
  workspaceDependencies = '',
  registryPackages = ['serde'],
  thirdPartyTargets = ['serde'],
  foreignPackages = {},
  extraFiles = [],
  rootManifest,
  projectOptions = {},
  render,
}: {
  readonly members: Readonly<Record<string, CargoFixtureMember>>
  readonly edition?: string
  readonly workspaceVersion?: string
  readonly workspacePackageFields?: string
  readonly workspaceDependencies?: string
  readonly registryPackages?: readonly string[]
  readonly thirdPartyTargets?: readonly string[]
  /** Repository-relative package paths of Cargo packages outside `rust/`; `projected` adds BUCK.genie.ts. */
  readonly foreignPackages?: Readonly<
    Record<string, CargoFixtureMember & { readonly projected: boolean }>
  >
  /** Repository-relative files outside any member (for example build script inputs). */
  readonly extraFiles?: readonly string[]
  /** Repository-root Cargo.toml, for foreign packages owned by a root workspace. */
  readonly rootManifest?: string
  readonly render: string
  readonly projectOptions?: Omit<CargoBuck2PackageProjectionOptions, 'sourceUrl'>
}): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'cargo-projection-discovery-'))
  const write = (relativePath: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
    writeFileSync(path.join(root, relativePath), content)
  }
  const memberManifest = (memberPath: string, manifest: string) => {
    const [header, ...rest] = manifest.split('\n[')
    const workspaceKey =
      memberPath === '.'
        ? ''
        : `workspace = "${memberPath
            .split('/')
            .map(() => '..')
            .join('/')}"\n`
    return [
      `${header}\nversion.workspace = true\nedition.workspace = true\n${workspaceKey}`,
      ...rest.map((section) => `[${section}`),
    ].join('\n')
  }
  const rootMember = members['.']
  try {
    write('megarepo.kdl', '')
    write(
      'rust/Cargo.toml',
      `[workspace]\nresolver = "2"\nmembers = [${Object.keys(members)
        .map((member) => JSON.stringify(member))
        .join(
          ', ',
        )}]\n\n[workspace.package]\nversion = "${workspaceVersion}"\nedition = "${edition}"\n${workspacePackageFields}\n[workspace.dependencies]\nserde = "1"\n${workspaceDependencies}${
        rootMember === undefined ? '' : `\n${memberManifest('.', rootMember.manifest)}`
      }`,
    )
    write(
      'rust/Cargo.lock',
      `version = 4\n${registryPackages
        .map(
          (name) =>
            `\n[[package]]\nname = "${name}"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
        )
        .join('')}`,
    )
    write(
      'rust/reindeer.toml',
      'vendor = false\ncargo_env = true\nthird_party_dir = "third-party"\n',
    )
    write(
      'rust/third-party/BUCK',
      thirdPartyTargets
        .map((name) => `alias(\n    name = "${name}",\n    actual = ":${name}-1.0.0",\n)\n`)
        .join('\n'),
    )
    for (const [packagePath, foreign] of Object.entries(foreignPackages)) {
      write(`${packagePath}/Cargo.toml`, foreign.manifest)
      for (const file of foreign.files) write(`${packagePath}/${file}`, '// fixture\n')
      if (foreign.projected === true) write(`${packagePath}/BUCK.genie.ts`, '// projected\n')
    }
    if (Object.keys(foreignPackages).length > 0) {
      write(
        'rust/foreign-packages.json',
        JSON.stringify({
          foreignPackageManifestPaths: Object.keys(foreignPackages).map(
            (packagePath) => `${packagePath}/Cargo.toml`,
          ),
        }),
      )
      write('rust/third-party/cargo-resolution.json', '{"dependencies":[]}\n')
    }
    for (const file of extraFiles) write(file, '// fixture\n')
    if (rootManifest !== undefined) write('Cargo.toml', rootManifest)
    for (const [memberPath, member] of Object.entries(members)) {
      if (memberPath !== '.') {
        write(`rust/${memberPath}/Cargo.toml`, memberManifest(memberPath, member.manifest))
      }
      for (const file of member.files) write(`rust/${memberPath}/${file}`, '// fixture\n')
      write(`rust/${memberPath}/BUCK.genie.ts`, '// Runtime-only projection fixture.\n')
    }
    const project = defineCargoBuck2PackageProjection({
      repoName: 'discovery-fixture',
      repoImportMetaUrl: pathToFileURL(path.join(root, 'projection.ts')).href,
      workspaceRoot: 'rust',
      workspaceMemberManifestPaths: Object.keys(members).map((memberPath) =>
        memberPath === '.' ? 'rust/Cargo.toml' : `rust/${memberPath}/Cargo.toml`,
      ),
      generatorSourcePaths: [],
    })
    return project({
      ...projectOptions,
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

/** Compile-time Cargo environment of one generated first-party rule. */
const compileEnvironment = (rule: string): Readonly<Record<string, string>> => {
  const body = rule.match(/^    env = \{([\s\S]*?)^    \},/m)?.[1]
  if (body === undefined) throw new Error('Cargo target has no compile-time environment')
  return Object.fromEntries(
    [...body.matchAll(/^        "([^"]+)": ("(?:\\.|[^"\\])*"),$/gm)].map(([, key, value]) => [
      key,
      JSON.parse(value) as string,
    ]),
  )
}

describe('Cargo dual Node-API and wasm products', () => {
  it('keeps macOS dynamic symbol lookup native-only on the shared cdylib', () => {
    const rendered = renderCargoFixture({
      members: {
        adapter: {
          manifest: '[package]\nname = "adapter"\n\n[lib]\ncrate-type = ["cdylib", "rlib"]',
          files: ['src/lib.rs'],
        },
      },
      render: 'adapter',
      projectOptions: {
        napi: { name: 'native-addon' },
        wasmBindgen: { name: 'wasm-addon' },
      },
    })
    // Both product wrappers consume the same library under different target configurations.
    for (const [kind, name] of [
      ['rust_napi_library', 'native-addon'],
      ['rust_wasm_bindgen_library', 'wasm-addon'],
    ]) {
      const product = rendered.match(new RegExp(`^${kind}\\(\\n([\\s\\S]*?)^\\)`, 'm'))?.[1]
      expect(product).toContain(`name = "${name}"`)
      expect(product).toContain('crate = ":lib"')
    }
    const library = renderedRules(rendered)['lib']
    const flagsExpression = library?.match(/^    rustc_flags = (.*),$/m)?.[1]
    if (flagsExpression === undefined) throw new Error('Shared cdylib has no rustc flags')
    // The generated select expression is also valid JavaScript. Evaluate its branches rather
    // than pinning the source spelling; wasm retains macOS through the product transition.
    const evaluateFlags = (conditions: readonly string[]): unknown =>
      new Function('select', `return ${flagsExpression}`)(
        (branches: Readonly<Record<string, readonly string[]>>) => {
          const matching = Object.keys(branches).filter((key) => conditions.includes(key))
          if (matching.length > 1) throw new Error('Ambiguous target configuration')
          return branches[matching[0] ?? 'DEFAULT']
        },
      )
    expect(evaluateFlags(['prelude//os/constraints:macos'])).toEqual([
      '-Clink-arg=-Wl,-undefined,dynamic_lookup',
    ])
    expect(evaluateFlags(['prelude//os/constraints:macos', '//buck2/rust:wasm32_config'])).toEqual(
      [],
    )
    expect(evaluateFlags(['//buck2/rust:wasm32_config'])).toEqual([])
    expect(evaluateFlags([])).toEqual([])
  })
})

describe('Cargo compile-time package identity', () => {
  it('inherits package fields and separates library, binary, and build-script target names', () => {
    const rendered = renderCargoFixture({
      workspaceVersion: '1.2.3-rc.4+meta',
      workspacePackageFields: [
        'authors = ["Ada", "Bob"]',
        'description = "Remote relay"',
        'homepage = "https://example.org/relay"',
        'repository = "https://example.org/source"',
        'license = "MIT"',
        'license-file = "LICENSE.txt"',
        'rust-version = "1.85"',
      ].join('\n'),
      members: {
        relay: {
          manifest: [
            '[package]',
            'name = "tailnet-relay"',
            'authors.workspace = true',
            'description.workspace = true',
            'homepage.workspace = true',
            'repository.workspace = true',
            'license.workspace = true',
            'license-file.workspace = true',
            'readme = false',
            'rust-version.workspace = true',
            '[[bin]]',
            'name = "devnet-edge"',
            'path = "src/bin/devnet-edge.rs"',
          ].join('\n'),
          files: ['README.md', 'src/lib.rs', 'src/main.rs', 'src/bin/devnet-edge.rs', 'build.rs'],
        },
      },
      render: 'relay',
    })
    const rules = renderedRules(rendered)
    const library = compileEnvironment(rules.lib)
    expect(library).toMatchObject({
      CARGO_PKG_NAME: 'tailnet-relay',
      CARGO_PKG_VERSION: '1.2.3-rc.4+meta',
      CARGO_PKG_VERSION_MAJOR: '1',
      CARGO_PKG_VERSION_MINOR: '2',
      CARGO_PKG_VERSION_PATCH: '3',
      CARGO_PKG_VERSION_PRE: 'rc.4',
      CARGO_PKG_AUTHORS: 'Ada:Bob',
      CARGO_PKG_DESCRIPTION: 'Remote relay',
      CARGO_PKG_HOMEPAGE: 'https://example.org/relay',
      CARGO_PKG_REPOSITORY: 'https://example.org/source',
      CARGO_PKG_LICENSE: 'MIT',
      CARGO_PKG_LICENSE_FILE: 'LICENSE.txt',
      CARGO_PKG_README: '',
      CARGO_PKG_RUST_VERSION: '1.85',
      CARGO_CRATE_NAME: 'tailnet_relay',
      CARGO_MANIFEST_DIR: 'rust/relay',
    })
    expect(library).not.toHaveProperty('CARGO_BIN_NAME')
    expect(compileEnvironment(rules['tailnet-relay'])).toMatchObject({
      CARGO_CRATE_NAME: 'tailnet_relay',
      CARGO_BIN_NAME: 'tailnet-relay',
    })
    expect(compileEnvironment(rules['devnet-edge'])).toMatchObject({
      CARGO_CRATE_NAME: 'devnet_edge',
      CARGO_BIN_NAME: 'devnet-edge',
    })
    expect(compileEnvironment(rules['tailnet-relay-build-script-build'])).toMatchObject({
      CARGO_CRATE_NAME: 'build_script_build',
      CARGO_PKG_AUTHORS: 'Ada:Bob',
    })
    expect(compileEnvironment(rules['tailnet-relay-build-script-build'])).not.toHaveProperty(
      'CARGO_BIN_NAME',
    )
    const run = rendered.match(/^buildscript_run\(\n[\s\S]*?^\)$/m)?.[0]
    if (run === undefined) throw new Error('Cargo target has no build-script run')
    expect(compileEnvironment(run)).toMatchObject({
      CARGO_PKG_NAME: 'tailnet-relay',
      CARGO_PKG_VERSION: '1.2.3-rc.4+meta',
      CARGO_PKG_VERSION_MAJOR: '1',
      CARGO_PKG_VERSION_MINOR: '2',
      CARGO_PKG_VERSION_PATCH: '3',
      CARGO_PKG_VERSION_PRE: 'rc.4',
      CARGO_PKG_LICENSE: 'MIT',
      CARGO_PKG_LICENSE_FILE: 'LICENSE.txt',
      CARGO_CRATE_NAME: 'build_script_build',
    })
  })

  it('selects the first present package README unless the manifest disables it', () => {
    for (const [files, expected] of [
      [['README.md', 'README.txt', 'README'], 'README.md'],
      [['README.txt', 'README'], 'README.txt'],
      [['README'], 'README'],
    ] as const) {
      const rules = renderedRules(
        renderCargoFixture({
          members: {
            cli: { manifest: '[package]\nname = "cli"', files: ['src/main.rs', ...files] },
          },
          render: 'cli',
        }),
      )
      expect(compileEnvironment(rules.cli).CARGO_PKG_README).toBe(expected)
    }
  })

  it('supplies empty Cargo metadata variables when the manifest omits them', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: { cli: { manifest: '[package]\nname = "cli"', files: ['src/main.rs'] } },
        render: 'cli',
      }),
    )
    const env = compileEnvironment(rules.cli)
    for (const key of [
      'CARGO_PKG_AUTHORS',
      'CARGO_PKG_DESCRIPTION',
      'CARGO_PKG_HOMEPAGE',
      'CARGO_PKG_REPOSITORY',
      'CARGO_PKG_LICENSE',
      'CARGO_PKG_LICENSE_FILE',
      'CARGO_PKG_README',
      'CARGO_PKG_RUST_VERSION',
      'CARGO_PKG_VERSION_PRE',
    ]) {
      expect(env[key]).toBe('')
    }
  })
})

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
    // Every src/ file, binary roots included, can be a library module (`mod main;`).
    expect(rules.lib).toContain(
      'srcs = [\n        "src/bin/extra.rs",\n        "src/bin/multi/args.rs",\n        "src/bin/multi/main.rs",\n        "src/lib.rs",\n        "src/main.rs",\n        "src/util.rs",\n    ],',
    )
    expect(rules['my-tool']).toContain('crate = "my_tool",\n    crate_root = "src/main.rs",')
    expect(rules['my-tool']).toContain('deps = [\n        ":lib",\n    ],')
    expect(rules.extra).toContain(
      'crate_root = "src/bin/extra.rs",\n    srcs = [\n        "src/bin/extra.rs",\n        "src/bin/multi/args.rs",\n        "src/bin/multi/main.rs",\n        "src/lib.rs",\n        "src/main.rs",\n        "src/util.rs",\n    ],',
    )
    expect(rules.multi).toContain(
      'crate_root = "src/bin/multi/main.rs",\n    srcs = [\n        "src/bin/extra.rs",\n        "src/bin/multi/args.rs",\n        "src/bin/multi/main.rs",\n        "src/lib.rs",\n        "src/main.rs",\n        "src/util.rs",\n    ],',
    )
  })

  it('lets flat src/bin binaries load every src/bin module', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          kit: {
            manifest: '[package]\nname = "kit"',
            files: [
              'src/bin/tool.rs',
              'src/bin/helper.rs',
              'src/bin/dir/main.rs',
              'src/bin/dir/x.rs',
            ],
          },
        },
        render: 'kit',
      }),
    )
    expect(Object.keys(rules)).toEqual(['dir', 'helper', 'tool'])
    expect(rules.tool).toContain(
      'crate_root = "src/bin/tool.rs",\n    srcs = [\n        "src/bin/dir/main.rs",\n        "src/bin/dir/x.rs",\n        "src/bin/helper.rs",\n        "src/bin/tool.rs",\n    ],',
    )
    expect(rules.dir).toContain(
      'crate_root = "src/bin/dir/main.rs",\n    srcs = [\n        "src/bin/dir/main.rs",\n        "src/bin/dir/x.rs",\n        "src/bin/helper.rs",\n        "src/bin/tool.rs",\n    ],',
    )
  })

  it('rejects binary names that collide with generated Buck targets', () => {
    const render = (files: readonly string[]) =>
      renderCargoFixture({
        members: { pkg: { manifest: '[package]\nname = "pkg"', files } },
        render: 'pkg',
      })
    expect(() => render(['src/lib.rs', 'src/bin/lib.rs'])).toThrow(
      'Cargo binary names collide with generated Buck targets in rust/pkg/Cargo.toml: lib',
    )
    expect(() => render(['src/bin/static_sources.rs'])).toThrow(
      'Cargo binary names collide with generated Buck targets in rust/pkg/Cargo.toml: static_sources',
    )
    expect(Object.keys(renderedRules(render(['src/bin/lib.rs'])))).toEqual(['lib'])
  })

  it('lets a binary load a peer binary root as a module', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          app: {
            manifest: '[package]\nname = "app"\n\n[[bin]]\nname = "tool"\npath = "src/tool.rs"',
            files: ['src/main.rs', 'src/tool.rs'],
          },
        },
        render: 'app',
      }),
    )
    expect(Object.keys(rules)).toEqual(['tool', 'app'])
    expect(rules.app).toContain(
      'crate_root = "src/main.rs",\n    srcs = [\n        "src/main.rs",\n        "src/tool.rs",\n    ],',
    )
  })

  it('keeps binary sources the library can load as modules', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          pkg: {
            manifest: '[package]\nname = "pkg"\n\n[[bin]]\nname = "tool"\npath = "src/tool.rs"',
            files: ['src/lib.rs', 'src/tool.rs', 'src/bin/mod.rs', 'src/bin/helper.rs'],
          },
        },
        render: 'pkg',
      }),
    )
    expect(Object.keys(rules)).toEqual(['lib', 'tool', 'helper', 'mod'])
    expect(rules.lib).toContain(
      'srcs = [\n        "src/bin/helper.rs",\n        "src/bin/mod.rs",\n        "src/lib.rs",\n        "src/tool.rs",\n    ],',
    )
  })

  it('lets a package binary load src/bin/mod.rs as a module', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          app: { manifest: '[package]\nname = "app"', files: ['src/main.rs', 'src/bin/mod.rs'] },
        },
        render: 'app',
      }),
    )
    expect(Object.keys(rules)).toEqual(['app', 'mod'])
    expect(rules.app).toContain(
      'crate_root = "src/main.rs",\n    srcs = [\n        "src/bin/mod.rs",\n        "src/main.rs",\n    ],',
    )
  })

  it('keeps targets that share a crate root', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          pkg: {
            manifest:
              '[package]\nname = "pkg"\n\n[lib]\npath = "src/shared.rs"\n\n[[bin]]\nname = "one"\npath = "src/shared.rs"\n\n[[bin]]\nname = "two"\npath = "src/shared.rs"',
            files: ['src/shared.rs'],
          },
        },
        render: 'pkg',
      }),
    )
    expect(Object.keys(rules)).toEqual(['lib', 'one', 'two'])
    expect(rules.lib).toContain(
      'crate_root = "src/shared.rs",\n    srcs = [\n        "src/shared.rs",\n    ],',
    )
    expect(rules.two).toContain(
      'crate_root = "src/shared.rs",\n    srcs = [\n        "src/shared.rs",\n    ],',
    )
  })

  it('skips hidden paths in automatic binary discovery', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          solo: {
            manifest: '[package]\nname = "solo"',
            files: [
              'src/main.rs',
              'src/cli.rs',
              'src/bin/tool.rs',
              'src/bin/.scratch.rs',
              'src/bin/.hidden/main.rs',
            ],
          },
        },
        render: 'solo',
      }),
    )
    expect(Object.keys(rules)).toEqual(['solo', 'tool'])
    expect(rules.solo).toContain('crate_root = "src/main.rs",')
    expect(rules.tool).toContain('crate_root = "src/bin/tool.rs",')
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

describe('Cargo binary ambiguity', () => {
  const binaryNames = (manifest: string, files: readonly string[]) =>
    Object.keys(
      renderedRules(
        renderCargoFixture({
          members: { pkg: { manifest: `[package]\nname = "pkg"${manifest}`, files } },
          render: 'pkg',
        }),
      ),
    )

  it('ignores inferred binaries claimed by an explicit name or path', () => {
    expect(
      binaryNames('\n\n[[bin]]\nname = "pkg"\npath = "src/main.rs"', [
        'src/main.rs',
        'src/bin/pkg.rs',
      ]),
    ).toEqual(['pkg'])
    expect(
      binaryNames('\n\n[[bin]]\nname = "twin"\npath = "src/bin/twin.rs"', [
        'src/lib.rs',
        'src/bin/twin.rs',
        'src/bin/twin/main.rs',
      ]),
    ).toEqual(['lib', 'twin'])
  })

  it('ignores duplicate inferable binaries when autobins is off', () => {
    expect(
      binaryNames('\nautobins = false', ['src/lib.rs', 'src/bin/twin.rs', 'src/bin/twin/main.rs']),
    ).toEqual(['lib'])
  })

  it('rejects a path-less explicit binary with several candidate roots', () => {
    expect(() =>
      binaryNames('\n\n[[bin]]\nname = "twin"', ['src/bin/twin.rs', 'src/bin/twin/main.rs']),
    ).toThrow('Cargo binary target discovery is ambiguous in rust/pkg/Cargo.toml: twin')
  })

  it('rejects edition 2015 target inference', () => {
    expect(() =>
      renderCargoFixture({
        members: { pkg: { manifest: '[package]\nname = "pkg"', files: ['src/main.rs'] } },
        edition: '2015',
        render: 'pkg',
      }),
    ).toThrow('Cargo edition 2015 is unsupported in rust/Cargo.toml')
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
      'Cargo path dependency at dependencies.ghost is neither a workspace member nor a declared foreign package: rust/crates/ghost',
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

describe('Cargo cross-workspace path dependencies', () => {
  const sharedLibrary = (projected: boolean) => ({
    'shared/otel-bootstrap': {
      manifest:
        '[package]\nname = "otel-bootstrap"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n',
      files: ['src/lib.rs'],
      projected,
    },
  })
  const consumer = {
    app: {
      manifest:
        '[package]\nname = "app"\n\n[dependencies]\notel-bootstrap = { path = "../../shared/otel-bootstrap" }',
      files: ['src/main.rs'],
    },
  }

  it('rejects undeclared and unprojected foreign packages', () => {
    expect(() => renderCargoFixture({ members: consumer, render: 'app' })).toThrow(
      'Cargo path dependency at dependencies.otel-bootstrap is neither a workspace member nor a declared foreign package: shared/otel-bootstrap',
    )
    expect(() =>
      renderCargoFixture({
        members: consumer,
        foreignPackages: sharedLibrary(false),
        render: 'app',
      }),
    ).toThrow(
      'Foreign Cargo package must itself be Buck-projected (no BUCK.genie.ts): shared/otel-bootstrap',
    )
  })
})

describe('Cargo renamed dependencies', () => {
  const renamed = (dependency: string) => ({
    relay: {
      manifest: `[package]\nname = "relay"\n\n[dependencies]\n${dependency}\nserde.workspace = true`,
      files: ['src/main.rs'],
    },
  })

  it('binds the request name to the rename-named alias of a root package', () => {
    const rendered = renderCargoFixture({
      members: {
        '.': {
          manifest:
            '[package]\nname = "relay"\n\n[dependencies]\nwebpki = { package = "rustls-webpki", version = "0.103" }\nserde.workspace = true',
          files: ['src/main.rs'],
        },
      },
      registryPackages: ['rustls-webpki', 'serde'],
      thirdPartyTargets: ['serde', 'webpki'],
      render: '.',
    })
    expect(renderedRules(rendered).relay).toContain(
      'deps = [\n        "//rust/third-party:serde",\n    ],\n    named_deps = {\n        "webpki": "//rust/third-party:webpki",\n    },',
    )
  })

  it('falls back to the package-named alias of a virtual workspace graph', () => {
    const rendered = renderCargoFixture({
      members: renamed('webpki.workspace = true'),
      workspaceDependencies: 'webpki = { package = "rustls-webpki", version = "0.103" }\n',
      registryPackages: ['rustls-webpki', 'serde'],
      thirdPartyTargets: ['rustls-webpki', 'serde'],
      render: 'relay',
    })
    expect(renderedRules(rendered).relay).toContain(
      'named_deps = {\n        "webpki": "//rust/third-party:rustls-webpki",\n    },',
    )
  })

  it('never binds a rename to an unrelated crate named like the request', () => {
    const rendered = renderCargoFixture({
      members: {
        ...renamed('webpki = { package = "rustls-webpki", version = "0.103" }'),
        other: {
          manifest: '[package]\nname = "other"\n\n[dependencies]\nwebpki = "0.22"',
          files: ['src/lib.rs'],
        },
      },
      registryPackages: ['rustls-webpki', 'serde', 'webpki'],
      thirdPartyTargets: ['rustls-webpki', 'serde', 'webpki'],
      render: 'relay',
    })
    expect(renderedRules(rendered).relay).toContain(
      'named_deps = {\n        "webpki": "//rust/third-party:rustls-webpki",\n    },',
    )
  })

  it('ignores a root rename of the same request name to another package', () => {
    const rendered = renderCargoFixture({
      members: {
        '.': {
          manifest:
            '[package]\nname = "root"\n\n[dependencies]\nwebpki = { package = "crate-a", version = "1" }',
          files: ['src/lib.rs'],
        },
        ...renamed('webpki = { package = "rustls-webpki", version = "0.103" }'),
      },
      registryPackages: ['crate-a', 'rustls-webpki', 'serde'],
      thirdPartyTargets: ['rustls-webpki', 'serde', 'webpki'],
      render: 'relay',
    })
    expect(renderedRules(rendered).relay).toContain(
      'named_deps = {\n        "webpki": "//rust/third-party:rustls-webpki",\n    },',
    )
  })

  it('rejects renames of path dependencies and unlocked packages', () => {
    expect(() =>
      renderCargoFixture({
        members: renamed('webpki = { package = "rustls-webpki", version = "0.103" }'),
        thirdPartyTargets: ['serde', 'webpki'],
        render: 'relay',
      }),
    ).toThrow('Cargo.lock has no package for dependency rustls-webpki at dependencies.webpki')
    expect(() =>
      renderCargoFixture({
        members: renamed('webpki = { package = "rustls-webpki", path = "../vendored" }'),
        render: 'relay',
      }),
    ).toThrow('Unsupported renamed Cargo path or workspace dependency at dependencies.webpki')
  })
})

describe('Cargo multi-product packages', () => {
  const renderPackage = (
    projectOptions: Omit<CargoBuck2PackageProjectionOptions, 'sourceUrl'>,
    files: readonly string[] = ['src/main.rs', 'src/bin/devnet-edge.rs'],
  ) =>
    renderCargoFixture({
      members: { relay: { manifest: '[package]\nname = "tailnet-relay"', files } },
      render: 'relay',
      projectOptions,
    })
  /** The product rule blocks, in emission order. */
  const productBlocks = (rendered: string): readonly string[] =>
    [...rendered.matchAll(/^(?:rust_product_executable|build_product)\([\s\S]*?^\)$/gm)].map(
      (match) => match[0],
    )

  it('emits one executable/product pair per named binary', () => {
    const rendered = renderPackage({
      buildProducts: [
        { name: 'tailnet-relay' },
        { name: 'edge', binary: 'devnet-edge', entrypoint: 'libexec/devnet-edge' },
      ],
    })
    expect(productBlocks(rendered)).toEqual([
      'rust_product_executable(\n    name = "tailnet-relay-product-executable",\n    binary = ":tailnet-relay",\n    recipe = "cargo-workspace:tailnet-relay@0.1.0",\n    target_platform = host_platform_label(),\n)',
      'build_product(\n    name = "tailnet-relay-product",\n    entrypoint = "bin/tailnet-relay",\n    executable = ":tailnet-relay-product-executable",\n    product_name = "tailnet-relay",\n    target_platform = host_platform_label(),\n)',
      'rust_product_executable(\n    name = "edge-product-executable",\n    binary = ":devnet-edge",\n    recipe = "cargo-workspace:tailnet-relay@0.1.0",\n    target_platform = host_platform_label(),\n)',
      'build_product(\n    name = "edge-product",\n    entrypoint = "libexec/devnet-edge",\n    executable = ":edge-product-executable",\n    product_name = "edge",\n    target_platform = host_platform_label(),\n)',
    ])
    expect(rendered).toContain('"build_product")')
  })

  it('renders a one-entry buildProducts like buildProduct', () => {
    const single = ['src/main.rs']
    const withoutHeader = (rendered: string) =>
      rendered.replace(/^# Semantic fingerprint: .*$/m, '')
    expect(
      withoutHeader(renderPackage({ buildProducts: [{ name: 'tailnet-relay' }] }, single)),
    ).toBe(withoutHeader(renderPackage({ buildProduct: true }, single)))
  })

  it('rejects ambiguous, unknown, repeated, unsafe, and colliding products', () => {
    expect(() => renderPackage({ buildProduct: true })).toThrow(
      'BuildProduct projection requires exactly one binary in rust/relay/Cargo.toml',
    )
    expect(() =>
      renderPackage({ buildProduct: true, buildProducts: [{ name: 'tailnet-relay' }] }),
    ).toThrow('buildProduct and buildProducts are mutually exclusive in rust/relay/Cargo.toml')
    expect(() => renderPackage({ buildProducts: [] })).toThrow(
      'buildProducts must name at least one product in rust/relay/Cargo.toml',
    )
    expect(() => renderPackage({ buildProducts: [{ name: 'ghost' }] })).toThrow(
      'buildProducts[0] packages unknown Cargo binary ghost in rust/relay/Cargo.toml (binaries: devnet-edge, tailnet-relay)',
    )
    expect(() =>
      renderPackage({
        buildProducts: [
          { name: 'tailnet-relay' },
          { name: 'tailnet-relay', binary: 'devnet-edge' },
        ],
      }),
    ).toThrow('buildProducts names repeat in rust/relay/Cargo.toml: tailnet-relay')
    expect(() =>
      renderPackage({ buildProducts: [{ name: 'a")\nrule(', binary: 'devnet-edge' }] }),
    ).toThrow('buildProducts[0].name is not a Buck target-safe product name')
    expect(() =>
      renderPackage({ buildProducts: [{ name: 'tailnet-relay', entrypoint: '../escape' }] }),
    ).toThrow('buildProducts[0].entrypoint must be a normalized relative path: ../escape')
    expect(() =>
      renderPackage({ buildProducts: [{ name: 'x', binary: 'tailnet-relay' }] }, [
        'src/main.rs',
        'src/bin/x-product.rs',
      ]),
    ).toThrow(
      'Cargo binary names collide with generated Buck targets in rust/relay/Cargo.toml: x-product',
    )
  })
})

describe('Cargo features', () => {
  const tokenlens = (cliDependency: string) => ({
    lib: {
      manifest:
        '[package]\nname = "lib"\n\n[features]\ndefault = []\nsqlite = ["dep:hostname", "dep:rusqlite"]\n\n[dependencies]\nserde.workspace = true\nhostname = { workspace = true, optional = true }\nrusqlite = { workspace = true, optional = true }',
      files: ['src/lib.rs'],
    },
    cli: {
      manifest: `[package]\nname = "cli"\n\n[dependencies]\n${cliDependency}`,
      files: ['src/main.rs'],
    },
  })
  const renderTokenlens = (cliDependency: string) =>
    renderCargoFixture({
      members: tokenlens(cliDependency),
      workspaceDependencies: 'hostname = "0.4"\nrusqlite = "0.39"\n',
      registryPackages: ['serde', 'hostname', 'rusqlite'],
      thirdPartyTargets: ['serde', 'hostname', 'rusqlite'],
      render: 'lib',
    })

  it('unifies a dependent-enabled feature into the library and its dep: edges', () => {
    const rules = renderedRules(renderTokenlens('lib = { path = "../lib", features = ["sqlite"] }'))
    expect(rules.lib).toContain(
      'deps = [\n        "//rust/third-party:hostname",\n        "//rust/third-party:rusqlite",\n        "//rust/third-party:serde",\n    ],',
    )
    expect(rules.lib).toContain('features = [\n        "default",\n        "sqlite",\n    ],')
  })

  it('leaves inactive optional dependencies out and the default-only feature set', () => {
    const rules = renderedRules(renderTokenlens('lib = { path = "../lib" }'))
    expect(rules.lib).toContain('deps = [\n        "//rust/third-party:serde",\n    ],')
    expect(rules.lib).toContain('features = [\n        "default",\n    ],')
  })

  it('follows default, implicit, dep/feature, and weak dep?/feature items', () => {
    const render = (appFeatures: string) =>
      renderedRules(
        renderCargoFixture({
          members: {
            core: {
              manifest:
                '[package]\nname = "core"\n\n[features]\ndefault = ["std"]\nstd = []\nturbo = ["serde?/derive", "util/fast"]\n\n[dependencies]\nserde = { version = "1", optional = true }\nutil = { path = "../util" }',
              files: ['src/lib.rs'],
            },
            util: {
              manifest: '[package]\nname = "util"\n\n[features]\nfast = []',
              files: ['src/lib.rs'],
            },
            app: {
              manifest: `[package]\nname = "app"\n\n[dependencies]\ncore = { path = "../core", features = [${appFeatures}] }`,
              files: ['src/main.rs'],
            },
          },
          render: 'core',
        }),
      ).lib
    // A weak item never activates `serde`; only the implicit `serde` feature does.
    expect(render('"turbo"')).toContain(
      'deps = [\n        "//rust/util:lib",\n    ],\n    edition = "2024",\n    features = [\n        "default",\n        "std",\n        "turbo",\n    ],',
    )
    expect(render('"turbo", "serde"')).toContain(
      'deps = [\n        "//rust/third-party:serde",\n        "//rust/util:lib",\n    ],\n    edition = "2024",\n    features = [\n        "default",\n        "serde",\n        "std",\n        "turbo",\n    ],',
    )
  })

  it('propagates dep/feature items into another member', () => {
    const rendered = renderCargoFixture({
      members: {
        core: {
          manifest:
            '[package]\nname = "core"\n\n[features]\nturbo = ["util/fast"]\n\n[dependencies]\nutil = { path = "../util" }',
          files: ['src/lib.rs'],
        },
        util: {
          manifest: '[package]\nname = "util"\n\n[features]\nfast = []',
          files: ['src/lib.rs'],
        },
        app: {
          manifest:
            '[package]\nname = "app"\n\n[dependencies]\ncore = { path = "../core", features = ["turbo"] }',
          files: ['src/main.rs'],
        },
      },
      render: 'util',
    })
    expect(renderedRules(rendered).lib).toContain('features = [\n        "fast",\n    ],')
  })

  it('omits a binary until its required-features are enabled', () => {
    const render = (features: string) =>
      Object.keys(
        renderedRules(
          renderCargoFixture({
            members: {
              forge: {
                manifest: `[package]\nname = "forge"\n\n[features]\n${features}refresh-fixtures = []\n\n[[bin]]\nname = "refresh-fixtures"\npath = "src/bin/refresh_fixtures.rs"\nrequired-features = ["refresh-fixtures"]`,
                files: ['src/lib.rs', 'src/bin/refresh_fixtures.rs'],
              },
            },
            render: 'forge',
          }),
        ),
      )
    expect(render('')).toEqual(['lib'])
    expect(render('default = ["refresh-fixtures"]\n')).toEqual(['lib', 'refresh-fixtures'])
  })

  it('rejects undefined, misplaced, and unprojectable feature requests', () => {
    expect(() => renderTokenlens('lib = { path = "../lib", features = ["postgres"] }')).toThrow(
      'Cargo feature postgres is not defined in rust/lib/Cargo.toml',
    )
    const single = (manifest: string, files: readonly string[] = ['src/lib.rs']) =>
      renderCargoFixture({
        members: { pkg: { manifest: `[package]\nname = "pkg"${manifest}`, files } },
        render: 'pkg',
      })
    expect(() =>
      single('\n\n[dev-dependencies]\nserde = { version = "1", optional = true }'),
    ).toThrow('Cargo dev-dependencies cannot be optional at dev-dependencies.serde')
    expect(() =>
      single('\n\n[features]\nx = ["dep:serde"]\n\n[dependencies]\nserde = "1"'),
    ).toThrow('Cargo feature dep:serde in rust/pkg/Cargo.toml names a non-optional dependency')
    expect(() => single('\n\n[features]\ndefault = ["ghost/x"]')).toThrow(
      'Cargo feature ghost/x in rust/pkg/Cargo.toml names no dependency ghost',
    )
    expect(() =>
      single(
        '\n\n[features]\nx = []\n\n[[bin]]\nname = "tool"\npath = "src/main.rs"\nrequired-features = ["y"]',
        ['src/main.rs'],
      ),
    ).toThrow('Cargo binary tool requires undefined features in rust/pkg/Cargo.toml: y')
  })

  it('unifies foreign feature requests without enabling disabled defaults', () => {
    for (const request of [
      'shared = { path = "../../shared", features = ["x"], default-features = false }',
      'shared = { path = "../../shared", default-features = false }\n\n[features]\ndefault = ["shared/x"]',
    ]) {
      const rules = renderedRules(
        renderCargoFixture({
          members: {
            pkg: {
              manifest: `[package]\nname = "pkg"\n\n[dependencies]\n${request}`,
              files: ['src/lib.rs'],
            },
          },
          foreignPackages: {
            shared: {
              manifest:
                '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2024"\n\n[features]\ndefault = ["y"]\nx = []\ny = []',
              files: ['src/lib.rs'],
              projected: true,
            },
          },
          render: 'pkg',
        }),
      )
      expect(rules['foreign-shared-lib']).toContain('features = [\n        "x",\n    ],')
      expect(rules['foreign-shared-lib']).not.toContain('"y"')
    }
  })

  it('inherits foreign metadata from a repository-root workspace', () => {
    const rules = renderedRules(
      renderCargoFixture({
        members: {
          pkg: {
            manifest:
              '[package]\nname = "pkg"\n\n[dependencies]\nshared = { path = "../../shared" }',
            files: ['src/lib.rs'],
          },
        },
        rootManifest:
          '[workspace]\nresolver = "2"\nmembers = ["shared"]\n\n[workspace.package]\nversion = "0.3.0"\nedition = "2021"\n',
        foreignPackages: {
          shared: {
            manifest:
              '[package]\nname = "shared"\nversion.workspace = true\nedition.workspace = true\n',
            files: ['src/lib.rs'],
            projected: true,
          },
        },
        render: 'pkg',
      }),
    )
    expect(rules['foreign-shared-lib']).toContain('"CARGO_PKG_VERSION": "0.3.0",')
    expect(rules['foreign-shared-lib']).toContain('edition = "2021",')
  })

  it('rejects feature requests and optional activation on target-specific member edges', () => {
    for (const request of [
      '{ path = "../lib", features = ["sqlite"] }',
      '{ path = "../lib", optional = true }',
    ]) {
      expect(() =>
        renderCargoFixture({
          members: {
            ...tokenlens('serde.workspace = true'),
            cli: {
              manifest: `[package]\nname = "cli"\n\n[target.'cfg(target_os = "linux")'.dependencies]\nlib = ${request}`,
              files: ['src/main.rs'],
            },
          },
          workspaceDependencies: 'hostname = "0.4"\nrusqlite = "0.39"\n',
          registryPackages: ['serde', 'hostname', 'rusqlite'],
          thirdPartyTargets: ['serde', 'hostname', 'rusqlite'],
          render: 'lib',
        }),
      ).toThrow(
        'Target-specific Cargo dependencies on workspace members cannot request features or be optional in rust/cli/Cargo.toml: lib',
      )
    }
  })
})

describe('Cargo git dependencies', () => {
  const render = (dependencies: string, workspaceDependencies = '') =>
    renderCargoFixture({
      members: {
        app: {
          manifest: `[package]\nname = "app"\n\n[dependencies]\n${dependencies}`,
          files: ['src/main.rs'],
        },
      },
      workspaceDependencies,
      registryPackages: ['serde', 'agent-spec', 'pty-core'],
      thirdPartyTargets: ['serde', 'agent-spec', 'pty-core'],
      render: 'app',
    })

  it('labels member and inherited git dependencies by their third-party alias', () => {
    expect(
      renderedRules(
        render(
          'agent-spec = { git = "https://github.com/o/st2", rev = "0123456789abcdef0123456789abcdef01234567" }\npty-core.workspace = true',
          'pty-core = { git = "https://github.com/o/pty-rust", branch = "main" }\n',
        ),
      ).app,
    ).toContain(
      'deps = [\n        "//rust/third-party:agent-spec",\n        "//rust/third-party:pty-core",\n    ],',
    )
  })

  it('rejects git mixed with path and git selectors without git', () => {
    expect(() =>
      render('agent-spec = { git = "https://github.com/o/st2", path = "../x" }'),
    ).toThrow(
      'Cargo dependency at dependencies.agent-spec cannot combine git with path or workspace',
    )
    expect(() => render('agent-spec = { version = "1", rev = "abc" }')).toThrow(
      'Cargo dependency at dependencies.agent-spec sets branch, rev, or tag without git',
    )
  })
})

describe('Cargo build scripts', () => {
  const render = ({
    manifest = '',
    files = ['src/lib.rs', 'build.rs'],
    buildScriptInputs,
  }: {
    readonly manifest?: string
    readonly files?: readonly string[]
    readonly buildScriptInputs?: CargoBuck2PackageProjectionOptions['buildScriptInputs']
  }) =>
    renderCargoFixture({
      members: { axe: { manifest: `[package]\nname = "axe"${manifest}`, files } },
      extraFiles: ['feedback/feedback-contract.json'],
      render: 'axe',
      projectOptions: buildScriptInputs === undefined ? {} : { buildScriptInputs },
    })

  it('rejects inputs repeating package files and feature requests on member build deps', () => {
    expect(() => render({ buildScriptInputs: [{ path: 'rust/axe/src/lib.rs' }] })).toThrow(
      'buildScriptInputs repeat files the build script already sees (Cargo.toml, the build script, Rust sources) in rust/axe/Cargo.toml: rust/axe/src/lib.rs',
    )
    for (const request of ['features = ["x"]', 'default-features = false']) {
      expect(() =>
        renderCargoFixture({
          members: {
            axe: {
              manifest: `[package]\nname = "axe"\n\n[build-dependencies]\ncodegen = { path = "../codegen", ${request} }`,
              files: ['src/lib.rs', 'build.rs'],
            },
            codegen: {
              manifest: '[package]\nname = "codegen"\n\n[features]\nx = []',
              files: ['src/lib.rs'],
            },
          },
          render: 'axe',
        }),
      ).toThrow(
        'Cargo build dependencies on first-party packages cannot request features or disable default features in rust/axe/Cargo.toml: codegen',
      )
    }
  })

  it('honors package.build paths and ignores build dependencies without a script', () => {
    expect(
      render({ manifest: '\nbuild = "tools/gen.rs"', files: ['src/lib.rs', 'tools/gen.rs'] }),
    ).toContain('    crate_root = "tools/gen.rs",')
    const scriptless = render({
      manifest: '\nbuild = false\n\n[build-dependencies]\nserde.workspace = true',
    })
    expect(scriptless).not.toContain('build-script')
  })

  it('rejects undeclared, mislabeled, and unsupported build script inputs', () => {
    expect(() =>
      render({ files: ['src/lib.rs'], buildScriptInputs: [{ path: 'rust/axe/src/lib.rs' }] }),
    ).toThrow('buildScriptInputs needs a Cargo build script in rust/axe/Cargo.toml')
    expect(() =>
      render({ buildScriptInputs: [{ path: 'feedback/feedback-contract.json' }] }),
    ).toThrow(
      'buildScriptInputs[0] outside rust/axe needs the Buck label providing it: feedback/feedback-contract.json',
    )
    expect(() =>
      render({ buildScriptInputs: [{ path: 'rust/axe/build.rs', label: '//rust/axe:build.rs' }] }),
    ).toThrow('buildScriptInputs[0] is inside rust/axe and takes no label: rust/axe/build.rs')
    expect(() => render({ manifest: '\nbuild = true', files: ['src/lib.rs'] })).toThrow(
      'Cargo package.build = true needs build.rs in rust/axe/Cargo.toml',
    )
    expect(() =>
      render({
        manifest: '\n\n[build-dependencies]\nser = { package = "serde", version = "1" }',
      }),
    ).toThrow(
      'Optional and renamed Cargo build dependencies are unsupported in rust/axe/Cargo.toml: ser',
    )
  })
})
