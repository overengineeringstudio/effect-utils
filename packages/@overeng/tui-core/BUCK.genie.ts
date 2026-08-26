import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

const rootManifestPath = path.join(process.cwd(), 'package.json')
const rootManifestValue: unknown = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
if (
  rootManifestValue === null ||
  Array.isArray(rootManifestValue) === true ||
  typeof rootManifestValue !== 'object'
) {
  throw new Error('Root package.json must contain an object')
}
const workspacesValue = Reflect.get(rootManifestValue, 'workspaces')
if (
  Array.isArray(workspacesValue) === false ||
  workspacesValue.some((workspace) => typeof workspace !== 'string') === true
) {
  throw new Error('Root package.json must declare an explicit string workspaces list')
}

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const packagePath = 'packages/@overeng/tui-core' as const
const regenerationCommand = 'devenv tasks run genie:run' as const
const sourceRoots = ['src', 'test'] as const
const sourceExtensions = new Set(['.cts', '.mts', '.ts', '.tsx'])
const semanticInputs = [
  'genie/buck2/mod.ts',
  'package.json.genie.ts',
  'packages/@overeng/buck2-tools/src/buck2-materializer.ts',
  'packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts',
  'packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts',
  'packages/@overeng/tui-core/BUCK.genie.ts',
  'packages/@overeng/tui-core/package.json.genie.ts',
  'packages/@overeng/tui-core/src/**/*.cts',
  'packages/@overeng/tui-core/src/**/*.mts',
  'packages/@overeng/tui-core/src/**/*.ts',
  'packages/@overeng/tui-core/src/**/*.tsx',
  'packages/@overeng/tui-core/test/**/*.cts',
  'packages/@overeng/tui-core/test/**/*.mts',
  'packages/@overeng/tui-core/test/**/*.ts',
  'packages/@overeng/tui-core/test/**/*.tsx',
  'packages/@overeng/tui-core/tsconfig.json.genie.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

const safeSourceSegment = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  segment.includes('/') === false &&
  segment.includes('\\') === false &&
  /^[A-Za-z0-9._@+-]+$/.test(segment)

const discoverPackageSources = (packageRoot: string): readonly string[] => {
  const absoluteRoot = path.join(process.cwd(), packageRoot)
  const sources: string[] = []

  const walk = (relativeDirectory: string): void => {
    const entries = readdirSync(path.join(absoluteRoot, relativeDirectory), {
      withFileTypes: true,
    }).toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
    for (const entry of entries) {
      if (safeSourceSegment(entry.name) === false) {
        throw new Error(`Unsafe package source path segment: ${entry.name}`)
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Package source census refuses symlink: ${relativePath}`)
      }
      if (entry.isDirectory() === true) {
        walk(relativePath)
      } else if (
        entry.isFile() === true &&
        sourceExtensions.has(path.extname(entry.name)) === true
      ) {
        sources.push(relativePath)
      }
    }
  }

  for (const sourceRoot of sourceRoots) walk(sourceRoot)
  if (sources.length === 0) throw new Error('Package source census found no TypeScript inputs')
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

const workspacePaths: readonly string[] = workspacesValue.toSorted((left, right) =>
  compareStrings({ left, right }),
)
const packageSources = discoverPackageSources(packagePath)
const patches = ['packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch'] as const
const runtime = '//:packages/@overeng/buck2-tools/src/buck2-materializer.ts'
const descriptorModule = '//:packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts'
const normalizer = '//:packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts'

const sourceLabel = (repoRelativePath: string): string =>
  repoRelativePath.startsWith(`${packagePath}/`) === true
    ? repoRelativePath.slice(packagePath.length + 1)
    : `//:${repoRelativePath}`

const starlarkString = (value: string): string => JSON.stringify(value)

const renderMap = ({
  name,
  entries,
}: {
  name: string
  entries: readonly (readonly [string, string])[]
}): readonly string[] => [
  `    ${name} = {`,
  ...entries.map(
    ([destination, source]) => `        ${starlarkString(destination)}: ${starlarkString(source)},`,
  ),
  '    },',
]

const workspaceManifestEntries = workspacePaths.map((workspace): readonly [string, string] => {
  const manifest = `${workspace}/package.json`
  return [manifest, sourceLabel(manifest)]
})
const packageFileEntries = [
  ...packageSources.map((source): readonly [string, string] => [source, source]),
  ['package.json', 'package.json'] as const,
  ['tsconfig.json', 'tsconfig.json'] as const,
].toSorted(([left], [right]) => compareStrings({ left, right }))
const patchEntries = patches.map((patch): readonly [string, string] => [patch, sourceLabel(patch)])

const data = {
  packagePath,
  packageSources,
  descriptorModule,
  normalizer,
  patches,
  runtime,
  workspacePaths,
}
const fingerprint = buck2SemanticFingerprint({
  generator: 'effect-utils/genie/buck2-materialization',
  schemaVersion: 1,
  semanticData: data,
})

const stringify = (): string => {
  const lines = [
    '# Projection source: packages/@overeng/tui-core/BUCK.genie.ts',
    '# Projection schema version: 1',
    '# Projection generator: effect-utils/genie/buck2-materialization',
    `# Semantic fingerprint: ${fingerprint}`,
    `# Semantic inputs: ${[
      ...semanticInputs,
      ...patches,
    ]
      .toSorted((left, right) => compareStrings({ left, right }))
      .join(', ')}`,
    `# Regenerate: ${regenerationCommand}`,
    '',
    'load("//buck2:materialization.bzl", "package_tree", "pnpm_node_modules")',
    'load("//buck2:typescript.bzl", "tsgo_emit", "tsgo_typecheck")',
    '',
    'pnpm_node_modules(',
    '    name = "node_modules",',
    '    package_name = "@overeng/tui-core",',
    '    root_package_json = "//:package.json",',
    '    lockfile = "//:pnpm-lock.yaml",',
    '    workspace_manifest = "//:pnpm-workspace.yaml",',
    ...renderMap({
      name: 'workspace_package_manifests',
      entries: workspaceManifestEntries,
    }),
    ...renderMap({ name: 'patches', entries: patchEntries }),
    `    runtime = ${starlarkString(runtime)},`,
    `    descriptor_module = ${starlarkString(descriptorModule)},`,
    `    normalizer = ${starlarkString(normalizer)},`,
    ')',
    '',
    'package_tree(',
    '    name = "package_tree",',
    '    node_modules = ":node_modules",',
    ...renderMap({ name: 'files', entries: packageFileEntries }),
    `    runtime = ${starlarkString(runtime)},`,
    '    workspace_siblings = {},',
    ')',
    '',
    'tsgo_typecheck(',
    '    name = "typecheck",',
    '    package_tree = ":package_tree",',
    ')',
    '',
    'tsgo_emit(',
    '    name = "dist",',
    '    package_tree = ":package_tree",',
    ')',
    '',
  ]
  return lines.join('\n')
}

export default createGenieOutput({ data, stringify })
