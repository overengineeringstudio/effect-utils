import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2SemanticFingerprint, renderBuck2Visibility } from './mod.ts'

const regenerationCommand = 'devenv tasks run genie:run' as const
const sourceExtensions = ['.cts', '.mts', '.ts', '.tsx'] as const
const sourceExtensionSet: Readonly<Record<string, true>> = {
  '.cts': true,
  '.mts': true,
  '.ts': true,
  '.tsx': true,
}
const commonSemanticInputs = [
  'genie/buck2/mod.ts',
  'genie/buck2/typescript-package-projection.ts',
  'package.json.genie.ts',
  'packages/@overeng/buck2-tools/src/buck2-materializer.ts',
  'packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts',
  'packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const safeSourceSegment = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  segment.includes('/') === false &&
  segment.includes('\\') === false &&
  /^[A-Za-z0-9._@+-]+$/.test(segment)

const discoverPackageSources = ({
  packagePath,
  sourceRoots,
}: {
  packagePath: string
  sourceRoots: readonly string[]
}): readonly string[] => {
  const absoluteRoot = path.join(process.cwd(), packagePath)
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
        sourceExtensionSet[path.extname(entry.name)] === true
      ) {
        sources.push(relativePath)
      }
    }
  }

  for (const sourceRoot of sourceRoots) {
    if (safeSourceSegment(sourceRoot) === false) {
      throw new Error(`Unsafe package source root: ${sourceRoot}`)
    }
    walk(sourceRoot)
  }
  if (sources.length === 0) throw new Error('Package source census found no TypeScript inputs')
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

const readWorkspacePaths = (): readonly string[] => {
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
  return workspacesValue.toSorted((left, right) => compareStrings({ left, right }))
}

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

export type Buck2WorkspaceSibling = {
  readonly packageName: string
  readonly packagePath: string
  readonly distTarget: `${string}//${string}:dist`
}

export type Buck2TypeScriptPackageProjection = {
  readonly packageName: string
  readonly packagePath: string
  readonly projectionSource: string
  readonly projectFile?: string
  readonly sourceRoots: readonly string[]
  readonly patches: readonly string[]
  readonly workspaceSiblings?: readonly Buck2WorkspaceSibling[]
}

export const buck2TypeScriptPackageProjection = ({
  packageName,
  packagePath,
  projectionSource,
  projectFile = 'tsconfig.json',
  sourceRoots,
  patches,
  workspaceSiblings = [],
}: Buck2TypeScriptPackageProjection): GenieOutput<unknown> => {
  if (safeSourceSegment(projectFile) === false) {
    throw new Error(`Unsafe package project file: ${projectFile}`)
  }
  const workspacePaths = readWorkspacePaths()
  const packageSources = discoverPackageSources({ packagePath, sourceRoots })
  const visibility = ['PUBLIC'] as const
  const runtime = 'effect_utils//:packages/@overeng/buck2-tools/src/buck2-materializer.ts'
  const descriptorModule =
    'effect_utils//:packages/@overeng/buck2-tools/src/pnpm-install-descriptor.ts'
  const normalizer = 'effect_utils//:packages/@overeng/buck2-tools/src/pnpm-deploy-normalizer.ts'

  const sourceLabel = (repoRelativePath: string): string =>
    repoRelativePath.startsWith(`${packagePath}/`) === true
      ? repoRelativePath.slice(packagePath.length + 1)
      : `effect_utils//:${repoRelativePath}`

  const workspaceManifestEntries = workspacePaths.map(
    (workspace): readonly [string, string] => {
      const manifest = `${workspace}/package.json`
      return [manifest, sourceLabel(manifest)]
    },
  )
  const projectFileEntries: readonly (readonly [string, string])[] =
    projectFile === 'tsconfig.json' ? [] : [[projectFile, projectFile]]
  const packageFileEntries = [
    ...packageSources.map((source): readonly [string, string] => [source, source]),
    ['package.json', 'package.json'] as const,
    ['tsconfig.json', 'tsconfig.json'] as const,
    ...projectFileEntries,
  ].toSorted(([left], [right]) => compareStrings({ left, right }))
  const patchEntries = patches.map(
    (patch): readonly [string, string] => [patch, sourceLabel(patch)],
  )
  const semanticInputs = [
    ...commonSemanticInputs,
    projectionSource,
    `${packagePath}/package.json.genie.ts`,
    `${packagePath}/tsconfig.json.genie.ts`,
    ...(projectFile === 'tsconfig.json'
      ? []
      : [`${packagePath}/${projectFile}.genie.ts`]),
    ...sourceRoots.flatMap((sourceRoot) =>
      sourceExtensions.map((extension) => `${packagePath}/${sourceRoot}/**/*${extension}`),
    ),
    ...workspaceSiblings.map((sibling) => `${sibling.packagePath}/package.json.genie.ts`),
    ...patches,
  ].toSorted((left, right) => compareStrings({ left, right }))

  const data = {
    packageName,
    packagePath,
    packageSources,
    descriptorModule,
    normalizer,
    patches,
    projectFile,
    runtime,
    sourceRoots,
    visibility,
    workspacePaths,
    workspaceSiblings,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator: 'effect-utils/genie/buck2-typescript-package-projection',
    schemaVersion: 1,
    semanticData: data,
  })

  const renderWorkspaceSiblings = (): readonly string[] => {
    if (workspaceSiblings.length === 0) return ['    workspace_siblings = {},']
    return [
      '    workspace_siblings = {',
      ...workspaceSiblings
        .toSorted((left, right) =>
          compareStrings({ left: left.packageName, right: right.packageName }),
        )
        .flatMap((sibling) => [
          `        ${starlarkString(sibling.packageName)}: {`,
          '            "files": {',
          `                "dist": ${starlarkString(sibling.distTarget)},`,
          `                "package.json": ${starlarkString(`effect_utils//:${sibling.packagePath}/package.json`)},`,
          '            },',
          `            "links": [${starlarkString(sibling.packageName)}],`,
          '        },',
        ]),
      '    },',
    ]
  }

  const stringify = (): string => {
    const lines = [
      `# Projection source: ${projectionSource}`,
      '# Projection schema version: 1',
      '# Projection generator: effect-utils/genie/buck2-typescript-package-projection',
      `# Semantic fingerprint: ${fingerprint}`,
      `# Semantic inputs: ${semanticInputs.join(', ')}`,
      `# Regenerate: ${regenerationCommand}`,
      '',
      'load("@effect_utils//buck2:materialization.bzl", "package_tree", "pnpm_editor_inputs", "pnpm_node_modules")',
      'load("@effect_utils//buck2:typescript.bzl", "tsgo_emit", "tsgo_typecheck")',
      '',
      'pnpm_node_modules(',
      '    name = "node_modules",',
      `    package_name = ${starlarkString(packageName)},`,
      '    root_package_json = "effect_utils//:package.json",',
      '    lockfile = "effect_utils//:pnpm-lock.yaml",',
      '    workspace_manifest = "effect_utils//:pnpm-workspace.yaml",',
      ...renderMap({
        name: 'workspace_package_manifests',
        entries: workspaceManifestEntries,
      }),
      ...renderMap({ name: 'patches', entries: patchEntries }),
      `    runtime = ${starlarkString(runtime)},`,
      `    descriptor_module = ${starlarkString(descriptorModule)},`,
      `    normalizer = ${starlarkString(normalizer)},`,
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'pnpm_editor_inputs(',
      '    name = "editor_inputs",',
      '    node_modules = ":node_modules",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'package_tree(',
      '    name = "package_tree",',
      '    node_modules = ":node_modules",',
      ...renderMap({ name: 'files', entries: packageFileEntries }),
      `    runtime = ${starlarkString(runtime)},`,
      ...renderWorkspaceSiblings(),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'tsgo_typecheck(',
      '    name = "typecheck",',
      '    package_tree = ":package_tree",',
      ...(projectFile === 'tsconfig.json'
        ? []
        : [`    project = ${starlarkString(projectFile)},`]),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'tsgo_emit(',
      '    name = "dist",',
      '    package_tree = ":package_tree",',
      ...(projectFile === 'tsconfig.json'
        ? []
        : [`    project = ${starlarkString(projectFile)},`]),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
    ]
    return lines.join('\n')
  }

  return createGenieOutput({ data, stringify })
}
