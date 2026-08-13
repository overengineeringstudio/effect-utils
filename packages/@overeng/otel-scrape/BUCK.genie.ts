import { existsSync, readdirSync } from 'node:fs'
import { extname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buck2ProjectionGenerator,
  buck2ProjectionSchemaVersion,
  buck2SemanticFingerprint,
} from '../../../genie/buck2/mod.ts'
import cargoWorkspace from '../../../rust/Cargo.toml' with { type: 'toml' }
import { createGenieOutput } from '../genie/src/runtime/core.ts'
import cargoManifest from './Cargo.toml' with { type: 'toml' }

const root = fileURLToPath(new URL('./', import.meta.url))
const compare = ([left, right]: readonly [string, string]): number =>
  left < right ? -1 : left > right ? 1 : 0
const walk = (directory: string): readonly string[] => {
  const result: string[] = []
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).toSorted(
      (a, b) => compare([a.name, b.name]),
    )) {
      if (entry.isSymbolicLink() === true)
        throw new Error(`Refusing Buck input symlink: ${relative}`)
      const path = posix.join(relative, entry.name)
      if (entry.isDirectory() === true) visit(path)
      else if (entry.isFile() === true) result.push(path)
    }
  }
  visit(directory)
  return result
}

type CargoDependency =
  | string
  | {
      readonly optional?: boolean
      readonly package?: string
      readonly workspace?: boolean
    }
export const cargoDependencyLabel = ([name, request]: readonly [
  string,
  CargoDependency,
]): string => {
  if (typeof request !== 'string' && request.package !== undefined)
    throw new Error(`Unsupported renamed Cargo dependency: ${name} -> ${request.package}`)
  if (typeof request !== 'string' && request.optional === true)
    throw new Error(`Unsupported optional Cargo dependency: ${name}`)
  return `//rust/third-party:${name}`
}
const manifest = cargoManifest as {
  readonly package?: {
    readonly name?: string
    readonly workspace?: string
    readonly version?: { readonly workspace?: boolean }
    readonly edition?: { readonly workspace?: boolean }
    readonly build?: string | boolean
  }
  readonly lib?: { readonly name?: string; readonly path?: string }
  readonly bin?: readonly {
    readonly name?: string
    readonly path?: string
    readonly 'required-features'?: readonly string[]
  }[]
  readonly dependencies?: Readonly<Record<string, CargoDependency>>
  readonly 'dev-dependencies'?: Readonly<Record<string, CargoDependency>>
  readonly 'build-dependencies'?: Readonly<Record<string, CargoDependency>>
  readonly features?: Readonly<Record<string, readonly string[]>>
  readonly target?: unknown
}
const workspace = cargoWorkspace as {
  readonly workspace?: {
    readonly package?: { readonly version?: string; readonly edition?: string }
  }
}
const requireValue = <T>({
  value,
  field,
}: {
  readonly value: T | undefined
  readonly field: string
}): T => {
  if (value === undefined) throw new Error(`Cargo metadata is missing ${field}`)
  return value
}
export const resolveCargoTargetMetadata = (args: {
  readonly defaultBuildScriptExists?: boolean
  readonly manifest: typeof manifest
  readonly workspace: typeof workspace
}) => {
  const packageMetadata = requireValue({ value: args.manifest.package, field: 'package' })
  if (packageMetadata.workspace !== '../../../rust')
    throw new Error('Unsupported Cargo workspace path')
  if (packageMetadata.version?.workspace !== true || packageMetadata.edition?.workspace !== true)
    throw new Error('Cargo package version and edition must inherit from the workspace')
  if (
    (packageMetadata.build !== undefined && packageMetadata.build !== false) ||
    args.defaultBuildScriptExists === true
  )
    throw new Error('Cargo build scripts are not supported by the OTEL Buck projection')
  if (args.manifest['build-dependencies'] !== undefined)
    throw new Error('Cargo build dependencies are not supported by the OTEL Buck projection')
  if (args.manifest.target !== undefined)
    throw new Error(
      'Target-conditioned Cargo dependencies are not supported by the OTEL Buck projection',
    )
  if (Object.keys(args.manifest.features ?? {}).length > 0)
    throw new Error('Cargo features are not supported by the OTEL Buck projection')
  const library = requireValue({ value: args.manifest.lib, field: 'lib' })
  const binaries = requireValue({ value: args.manifest.bin, field: 'bin' })
  if (binaries.length !== 1) throw new Error('Exactly one Cargo binary is supported')
  if ((binaries[0]?.['required-features']?.length ?? 0) > 0)
    throw new Error('Cargo binary required-features are not supported by the OTEL Buck projection')
  return {
    binaryName: requireValue({ value: binaries[0]?.name, field: 'bin[0].name' }),
    binaryPath: requireValue({ value: binaries[0]?.path, field: 'bin[0].path' }),
    edition: requireValue({
      value: args.workspace.workspace?.package?.edition,
      field: 'workspace.package.edition',
    }),
    libraryName: requireValue({ value: library.name, field: 'lib.name' }),
    libraryPath: requireValue({ value: library.path, field: 'lib.path' }),
    packageName: requireValue({ value: packageMetadata.name, field: 'package.name' }),
    version: requireValue({
      value: args.workspace.workspace?.package?.version,
      field: 'workspace.package.version',
    }),
  }
}
const { binaryName, binaryPath, edition, libraryName, libraryPath, packageName, version } =
  resolveCargoTargetMetadata({
    defaultBuildScriptExists: existsSync(join(root, 'build.rs')),
    manifest,
    workspace,
  })
const rustSources = walk('src').filter((path) => extname(path) === '.rs')
if (rustSources.includes(binaryPath) === false)
  throw new Error(`Cargo binary path is not a Rust source: ${binaryPath}`)
if (rustSources.includes(libraryPath) === false)
  throw new Error(`Cargo library path is not a Rust source: ${libraryPath}`)
if (binaryPath === libraryPath) throw new Error('Cargo binary and library paths must be distinct')
const librarySources = rustSources.filter((path) => path !== binaryPath).toSorted(compare)
const list = librarySources.map((path) => `        ${JSON.stringify(path)},`).join('\n')
const dependencyLabels = (dependencies: Readonly<Record<string, CargoDependency>> | undefined) =>
  Object.entries(dependencies ?? {})
    .map(cargoDependencyLabel)
    .toSorted(compare)
const normalDependencies = dependencyLabels(manifest.dependencies)
const devDependencies = dependencyLabels(manifest['dev-dependencies'])
const renderLabels = (labels: readonly string[]) =>
  labels.map((label) => `        ${JSON.stringify(label)},`).join('\n')
const semanticData = {
  devDependencies,
  binaryName,
  binaryPath,
  edition,
  libraryName,
  libraryPath,
  librarySources,
  normalDependencies,
  packageName,
  package: 'packages/@overeng/otel-scrape',
  targets: ['lib', 'otel-scrape', 'product', 'unit'],
  version,
}
const semanticFingerprint = buck2SemanticFingerprint({
  generator: buck2ProjectionGenerator,
  schemaVersion: buck2ProjectionSchemaVersion,
  semanticData,
})
const rendered = `# Projection source: packages/@overeng/otel-scrape/BUCK.genie.ts
# Projection schema version: ${buck2ProjectionSchemaVersion}
# Projection generator: ${buck2ProjectionGenerator}
# Semantic fingerprint: ${semanticFingerprint}
# Semantic inputs: rust/Cargo.toml, rust/Cargo.lock, rust/reindeer.toml, rust/third-party/BUCK, packages/@overeng/otel-scrape/Cargo.toml, packages/@overeng/otel-scrape/src/**/*.rs
# Regenerate: devenv tasks run genie:run

load("//packages/@overeng/otel-scrape/buck2:otel_scrape.bzl", "otel_scrape_targets")

otel_scrape_targets(
    binary_name = ${JSON.stringify(binaryName)},
    binary_path = ${JSON.stringify(binaryPath)},
    dev_deps = [
${renderLabels(devDependencies)}
    ],
    library_sources = [
${list}
    ],
    edition = ${JSON.stringify(edition)},
    library_name = ${JSON.stringify(libraryName)},
    library_path = ${JSON.stringify(libraryPath)},
    normal_deps = [
${renderLabels(normalDependencies)}
    ],
    package_name = ${JSON.stringify(packageName)},
    package_version = ${JSON.stringify(version)},
)
`

export default createGenieOutput({
  data: { ...semanticData, semanticFingerprint },
  stringify: () => rendered,
})
