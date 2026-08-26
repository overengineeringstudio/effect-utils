import { readFileSync } from 'node:fs'

import { createGenieOutput } from '../genie/src/runtime/core.ts'
import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import {
  discoverPackageSources,
  packagePath,
  regenerationCommand,
  semanticInputs,
} from './buck2/target.ts'

const rootManifestPath = new URL('../../../package.json', import.meta.url)
const rootManifestValue: unknown = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
if (
  rootManifestValue === null ||
  Array.isArray(rootManifestValue) ||
  typeof rootManifestValue !== 'object'
) {
  throw new Error('Root package.json must contain an object')
}
const workspacesValue = Reflect.get(rootManifestValue, 'workspaces')
if (
  Array.isArray(workspacesValue) === false ||
  workspacesValue.some((workspace) => typeof workspace !== 'string')
) {
  throw new Error('Root package.json must declare an explicit string workspaces list')
}

const workspacePaths: readonly string[] = workspacesValue.toSorted()
const packageSources = discoverPackageSources(new URL('./', import.meta.url))
const patches = [
  'packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch',
] as const
const runtime = '//:packages/@overeng/buck2-tools/src/buck2-materializer.ts'
const descriptorModule = '//:packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts'
const normalizer = '//:packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts'

const sourceLabel = (repoRelativePath: string): string =>
  repoRelativePath.startsWith(`${packagePath}/`)
    ? repoRelativePath.slice(packagePath.length + 1)
    : `//:${repoRelativePath}`

const starlarkString = (value: string): string => JSON.stringify(value)

const renderMap = (
  name: string,
  entries: readonly (readonly [string, string])[],
): readonly string[] => [
  `    ${name} = {`,
  ...entries.map(
    ([destination, source]) =>
      `        ${starlarkString(destination)}: ${starlarkString(source)},`,
  ),
  '    },',
]

const workspaceManifestEntries = workspacePaths.map(
  (workspace): readonly [string, string] => {
    const manifest = `${workspace}/package.json`
    return [manifest, sourceLabel(manifest)]
  },
)
const packageFileEntries = [
  ...packageSources.map(
    (source): readonly [string, string] => [source, source],
  ),
  ['package.json', 'package.json'] as const,
  ['tsconfig.json', 'tsconfig.json'] as const,
].toSorted(([left], [right]) => left.localeCompare(right, 'en'))
const patchEntries = patches.map(
  (patch): readonly [string, string] => [patch, sourceLabel(patch)],
)

const data = {
  packagePath,
  packageSources,
  descriptorModule,
  patches,
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
    `# Semantic inputs: ${[...semanticInputs, 'package.json.genie.ts', 'packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts', ...patches].toSorted().join(', ')}`,
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
    ...renderMap('workspace_package_manifests', workspaceManifestEntries),
    ...renderMap('patches', patchEntries),
    `    runtime = ${starlarkString(runtime)},`,
    `    descriptor_module = ${starlarkString(descriptorModule)},`,
    `    normalizer = ${starlarkString(normalizer)},`,
    ')',
    '',
    'package_tree(',
    '    name = "package_tree",',
    '    node_modules = ":node_modules",',
    ...renderMap('files', packageFileEntries),
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
