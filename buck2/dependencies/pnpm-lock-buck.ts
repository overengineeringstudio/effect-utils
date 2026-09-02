import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'
import type {
  PnpmDependencyReference,
  PnpmImporterMetadata,
  PnpmLockMetadata,
  PnpmSha256Sidecar,
} from './pnpm-lock.ts'
import { validatePnpmSha256Sidecar } from './pnpm-lock.ts'

const platforms = {
  linux_aarch64: { cpu: 'arm64', libc: 'glibc', os: 'linux' },
  linux_x86_64: { cpu: 'x64', libc: 'glibc', os: 'linux' },
  macos_aarch64: { cpu: 'arm64', libc: undefined, os: 'darwin' },
} as const

/** Admitted cpu/os configurations for generated dependency selects. */
export type PnpmPlatform = keyof typeof platforms

type PlatformClosure = {
  readonly bins: Readonly<Record<string, string>>
  readonly packageDependencies: Readonly<Record<string, string>>
  readonly packages: Readonly<Record<string, string>>
  readonly packageWorkspaceDependencies: Readonly<Record<string, string>>
  readonly rootDependencies: Readonly<Record<string, string>>
  readonly workspacePackageDependencies: Readonly<Record<string, string>>
}

type ImporterProjection = {
  readonly importer: string
  readonly platforms: Readonly<Record<PnpmPlatform, PlatformClosure>>
  readonly rootWorkspaceDependencies: Readonly<Record<string, string>>
  readonly target: string
  readonly workspaceTrees: Readonly<Record<string, string>>
  readonly workspaceWorkspaceDependencies: Readonly<Record<string, string>>
}

/** Complete generated Buck declaration projection for the translated lock. */
export type PnpmBuckProjection = {
  readonly fingerprint: `sha256:${string}`
  readonly importers: readonly ImporterProjection[]
  readonly metadata: PnpmLockMetadata
  readonly sidecar: PnpmSha256Sidecar
}

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedEntries = <TValue>(record: Readonly<Record<string, TValue>>) =>
  Object.entries(record).toSorted(([left], [right]) => compareStrings({ left, right }))

const fail = (message: string): never => {
  throw new Error(`Invalid pnpm Buck projection: ${message}`)
}

const workspaceKey = (importer: string): string => {
  const readable = importer
    .replaceAll(/[^A-Za-z0-9_]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 72)
  const digest = buck2SemanticFingerprint({
    generator: 'effect-utils/buck2/dependencies/workspace-key',
    schemaVersion: 1,
    semanticData: importer,
  }).slice('sha256:'.length, 'sha256:'.length + 12)
  return `workspace_${readable === '' ? 'root' : readable}_${digest}`
}

const platformAllows = ({
  constraints,
  value,
}: {
  constraints: readonly string[]
  value: string | undefined
}): boolean => {
  if (value === undefined) return constraints.length === 0
  if (constraints.includes(`!${value}`) === true) return false
  const positive = constraints.filter((constraint) => constraint.startsWith('!') === false)
  return positive.length === 0 || positive.includes(value)
}

const packageAllowed = ({
  metadata,
  packageKey,
  platform,
}: {
  metadata: PnpmLockMetadata
  packageKey: string
  platform: PnpmPlatform
}): boolean => {
  const packageMetadata = metadata.packages[packageKey]
  if (packageMetadata === undefined) return fail(`unknown package ${packageKey}`)
  const values = platforms[platform]
  return (
    platformAllows({ constraints: packageMetadata.cpu, value: values.cpu }) &&
    platformAllows({ constraints: packageMetadata.os, value: values.os }) &&
    (values.os !== 'linux' ||
      platformAllows({ constraints: packageMetadata.libc, value: values.libc }))
  )
}

type DependencyOwner =
  | { readonly kind: 'package'; readonly key: string }
  | { readonly kind: 'root' }
  | { readonly kind: 'workspace'; readonly key: string }

const makePlatformClosure = ({
  importer,
  metadata,
  platform,
  sidecar,
  workspaceTrees,
}: {
  importer: PnpmImporterMetadata
  metadata: PnpmLockMetadata
  platform: PnpmPlatform
  sidecar: PnpmSha256Sidecar
  workspaceTrees: Record<string, string>
}): PlatformClosure => {
  const packages: Record<string, string> = {}
  const packageDependencies: Record<string, string> = {}
  const rootDependencies: Record<string, string> = {}
  const bins: Record<string, string> = {}
  const packageWorkspaceDependencies: Record<string, string> = {}
  const workspacePackageDependencies: Record<string, string> = {}
  const visitedPackages = new Set<string>()

  const addRecord = ({
    dependencyName,
    owner,
    target,
  }: {
    dependencyName: string
    owner: DependencyOwner
    target: string
  }): void => {
    if (owner.kind === 'root') {
      rootDependencies[dependencyName] = target
    } else if (owner.kind === 'package') {
      packageDependencies[`${owner.key}\t${dependencyName}`] = target
    } else {
      workspacePackageDependencies[`${owner.key}\t${dependencyName}`] = target
    }
  }

  const visitWorkspace = ({
    dependencyName,
    owner,
    workspacePath,
  }: {
    dependencyName: string
    owner: DependencyOwner
    workspacePath: string
  }): void => {
    const key = workspaceKey(workspacePath)
    workspaceTrees[key] = `//${workspacePath}:package_tree`
    if (owner.kind === 'package') {
      packageWorkspaceDependencies[`${owner.key}\t${dependencyName}`] = key
    }
  }

  const visitPackage = ({
    dependencyName,
    owner,
    optional,
    snapshotKey,
  }: {
    dependencyName: string
    owner: DependencyOwner
    optional: boolean
    snapshotKey: string
  }): void => {
    const snapshot = metadata.snapshots[snapshotKey]
    if (snapshot === undefined) return fail(`unknown snapshot ${snapshotKey}`)
    const packageMetadata = metadata.packages[snapshot.package]
    if (packageMetadata === undefined) return fail(`snapshot ${snapshotKey} has unknown package`)
    const maySkip = optional || snapshot.optional
    if (packageAllowed({ metadata, packageKey: snapshot.package, platform }) === false) {
      if (maySkip === true) return
      return fail(`${snapshotKey} is required but incompatible with ${platform}`)
    }
    if (packageMetadata.resolution === 'workspace') {
      const workspacePath = packageMetadata.workspacePath
      if (workspacePath === undefined)
        return fail(`workspace package ${snapshot.package} has no path`)
      visitWorkspace({ dependencyName, owner, workspacePath })
      return
    }
    const targetKey = snapshot.virtualStoreName
    addRecord({ dependencyName, owner, target: targetKey })
    const existing = packages[targetKey]
    const label = `:${packageMetadata.target}`
    if (existing !== undefined && existing !== label) {
      return fail(`virtual store identity collision for ${targetKey}`)
    }
    packages[targetKey] = label
    if (visitedPackages.has(snapshotKey) === true) return
    visitedPackages.add(snapshotKey)
    for (const [name, reference] of sortedEntries(snapshot.dependencies)) {
      visitReference({
        dependencyName: name,
        owner: { kind: 'package', key: targetKey },
        optional: false,
        reference,
      })
    }
    for (const [name, reference] of sortedEntries(snapshot.optionalDependencies)) {
      visitReference({
        dependencyName: name,
        owner: { kind: 'package', key: targetKey },
        optional: true,
        reference,
      })
    }
  }

  const visitReference = ({
    dependencyName,
    owner,
    optional,
    reference,
  }: {
    dependencyName: string
    owner: DependencyOwner
    optional: boolean
    reference: PnpmDependencyReference
  }): void => {
    if (reference.kind === 'workspace') {
      visitWorkspace({ dependencyName, owner, workspacePath: reference.path })
    } else {
      visitPackage({ dependencyName, owner, optional, snapshotKey: reference.snapshot })
    }
  }

  const visitImporterDependencies = ({
    importer: importerMetadata,
    owner,
    optional,
  }: {
    importer: PnpmImporterMetadata
    owner: DependencyOwner
    optional: boolean
  }): void => {
    for (const dependencies of [importerMetadata.dependencies, importerMetadata.devDependencies]) {
      for (const [name, reference] of sortedEntries(dependencies)) {
        visitReference({ dependencyName: name, owner, optional, reference })
      }
    }
    for (const [name, reference] of sortedEntries(importerMetadata.optionalDependencies)) {
      visitReference({ dependencyName: name, owner, optional: true, reference })
    }
  }

  visitImporterDependencies({ importer, owner: { kind: 'root' }, optional: false })

  for (const [, reference] of [
    ...sortedEntries(importer.dependencies),
    ...sortedEntries(importer.devDependencies),
  ]) {
    if (reference.kind !== 'package') continue
    const snapshot = metadata.snapshots[reference.snapshot]
    if (snapshot === undefined || packages[snapshot.virtualStoreName] === undefined) continue
    const entry = sidecar.packages[snapshot.package]
    if (entry === undefined) continue
    for (const [binName, executable] of sortedEntries(entry.bins)) {
      const record = `${snapshot.virtualStoreName}\t${executable}`
      const existing = bins[binName]
      if (existing !== undefined && existing !== record) {
        return fail(`importer bin ${binName} is ambiguous between ${existing} and ${record}`)
      }
      bins[binName] = record
    }
  }

  return {
    bins,
    packageDependencies,
    packages,
    packageWorkspaceDependencies,
    rootDependencies,
    workspacePackageDependencies,
  }
}

const projectImporter = ({
  importerPath,
  metadata,
  sidecar,
}: {
  importerPath: string
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
}): ImporterProjection => {
  const importer = metadata.importers[importerPath]
  if (importer === undefined) return fail(`unknown importer ${importerPath}`)
  const workspaceTrees: Record<string, string> = {}
  const rootWorkspaceDependencies: Record<string, string> = {}
  const workspaceWorkspaceDependencies: Record<string, string> = {}

  const collectWorkspace = ({
    dependencyName,
    reference,
  }: {
    dependencyName: string
    reference: PnpmDependencyReference
  }): void => {
    if (reference.kind !== 'workspace') return
    const targetKey = workspaceKey(reference.path)
    workspaceTrees[targetKey] = `//${reference.path}:package_tree`
    rootWorkspaceDependencies[dependencyName] = targetKey
  }
  for (const dependencies of [
    importer.dependencies,
    importer.devDependencies,
    importer.optionalDependencies,
  ]) {
    for (const [name, reference] of sortedEntries(dependencies)) {
      collectWorkspace({ dependencyName: name, reference })
    }
  }

  const projectedPlatforms = Object.fromEntries(
    (Object.keys(platforms) as PnpmPlatform[]).map((platform) => [
      platform,
      makePlatformClosure({ importer, metadata, platform, sidecar, workspaceTrees }),
    ]),
  ) as Record<PnpmPlatform, PlatformClosure>
  return {
    importer: importerPath,
    platforms: projectedPlatforms,
    rootWorkspaceDependencies,
    target: importer.target,
    workspaceTrees,
    workspaceWorkspaceDependencies,
  }
}

/** Builds all per-importer platform closures from verified lock and sidecar data. */
export const makePnpmBuckProjection = ({
  metadata,
  sidecar,
}: {
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
}): PnpmBuckProjection => {
  validatePnpmSha256Sidecar({ metadata, sidecar })
  const importers = Object.keys(metadata.importers)
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((importerPath) => projectImporter({ importerPath, metadata, sidecar }))
  return {
    fingerprint: buck2SemanticFingerprint({
      generator: 'effect-utils/buck2/dependencies/BUCK',
      schemaVersion: 1,
      semanticData: { metadata, sidecarFingerprint: sidecar.fingerprint },
    }),
    importers,
    metadata,
    sidecar,
  }
}

const starlarkString = (value: string): string => JSON.stringify(value)

const renderDict = ({
  record,
  indent,
}: {
  record: Readonly<Record<string, string>>
  indent: number
}): readonly string[] => {
  const prefix = ' '.repeat(indent)
  return [
    '{',
    ...sortedEntries(record).map(
      ([key, value]) => `${prefix}    ${starlarkString(key)}: ${starlarkString(value)},`,
    ),
    `${prefix}}`,
  ]
}

const renderPlatformDict = ({
  field,
  importer,
  select,
}: {
  field: keyof PlatformClosure
  importer: ImporterProjection
  select: (closure: PlatformClosure) => Readonly<Record<string, string>>
}): readonly string[] => [
  `    ${field.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}_by_platform = {`,
  ...sortedEntries(importer.platforms).flatMap(([platform, closure]) => [
    `        ${starlarkString(platform)}: ${renderDict({ record: select(closure), indent: 8 }).join('\n')},`,
  ]),
  '    },',
]

/** Renders the loadable generated BUCK package declaration file. */
export const renderPnpmBuck = (projection: PnpmBuckProjection): string => {
  const lines = [
    '# Generated file - DO NOT EDIT',
    '# Source: pnpm-lock.yaml',
    '# Generator: buck2/dependencies/BUCK.genie.ts',
    `# Lock fingerprint: ${projection.metadata.lockfileFingerprint}`,
    `# Sidecar fingerprint: ${projection.sidecar.fingerprint}`,
    `# Semantic fingerprint: ${projection.fingerprint}`,
    '# Regenerate: devenv tasks run genie:run',
    '',
    'load(":defs.bzl", "pnpm_importer", "pnpm_package", "pnpm_platform_configurations")',
    '',
    'export_file(',
    '    name = "assemble-node-modules.ts",',
    '    src = "assemble-node-modules.ts",',
    '    visibility = ["PUBLIC"],',
    ')',
    '',
    'pnpm_platform_configurations()',
    '',
  ]
  for (const [packageKey, packageMetadata] of sortedEntries(projection.metadata.packages)) {
    if (packageMetadata.resolution !== 'registry') continue
    const hash = projection.sidecar.packages[packageKey]
    if (hash === undefined || packageMetadata.url === undefined)
      return fail(`missing sidecar entry ${packageKey}`)
    lines.push(
      'pnpm_package(',
      `    name = ${starlarkString(packageMetadata.target)},`,
      `    package_name = ${starlarkString(packageMetadata.name)},`,
      `    url = ${starlarkString(packageMetadata.url)},`,
      `    sha256 = ${starlarkString(hash.sha256)},`,
      `    bins = ${renderDict({ record: hash.bins, indent: 4 }).join('\n')},`,
      ...(packageMetadata.patch === undefined
        ? []
        : [`    patches = [${starlarkString(`//:${packageMetadata.patch.path}`)}],`]),
      ')',
      '',
    )
  }
  for (const importer of projection.importers) {
    lines.push(
      'pnpm_importer(',
      `    name = ${starlarkString(importer.target)},`,
      '    runtime = ":assemble-node-modules.ts",',
      ...renderPlatformDict({ field: 'packages', importer, select: (closure) => closure.packages }),
      ...renderPlatformDict({
        field: 'packageDependencies',
        importer,
        select: (closure) => closure.packageDependencies,
      }),
      ...renderPlatformDict({
        field: 'rootDependencies',
        importer,
        select: (closure) => closure.rootDependencies,
      }),
      ...renderPlatformDict({ field: 'bins', importer, select: (closure) => closure.bins }),
      ...renderPlatformDict({
        field: 'packageWorkspaceDependencies',
        importer,
        select: (closure) => closure.packageWorkspaceDependencies,
      }),
      ...renderPlatformDict({
        field: 'workspacePackageDependencies',
        importer,
        select: (closure) => closure.workspacePackageDependencies,
      }),
      `    workspace_trees = ${renderDict({ record: importer.workspaceTrees, indent: 4 }).join('\n')},`,
      `    workspace_workspace_dependencies = ${renderDict({ record: importer.workspaceWorkspaceDependencies, indent: 4 }).join('\n')},`,
      `    root_workspace_dependencies = ${renderDict({ record: importer.rootWorkspaceDependencies, indent: 4 }).join('\n')},`,
      '    visibility = ["PUBLIC"],',
      ')',
      '',
    )
  }
  return lines.join('\n')
}
