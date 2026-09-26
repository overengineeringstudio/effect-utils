import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import {
  createGenieOutput,
  type GenieOutput,
} from '../../../packages/@overeng/genie/src/runtime/core.ts'
import {
  defineRepoContext,
  modulePathFromUrl,
  type RepoContext,
} from '../../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'

export type CargoBuck2PackageProjectionOptions = {
  readonly buildProduct?: boolean
  readonly cliBuildStamp?: boolean
  readonly sourceUrl: string
}

export type CargoBuck2PackageProjection = (
  options: CargoBuck2PackageProjectionOptions,
) => GenieOutput<unknown>

export type DefineCargoBuck2PackageProjectionOptions = {
  readonly repoName: string
  readonly repoImportMetaUrl: string
  readonly workspaceRoot: string
  readonly cargoManifestPath?: string
  readonly cargoLockPath?: string
  readonly reindeerConfigPath?: string
  readonly workspaceMemberManifestPaths: readonly string[]
  readonly thirdPartyBuckPath?: string
  readonly thirdPartyPackage?: string
  readonly buck2LoadLabelPrefix?: string
  readonly generatorSourcePaths?: readonly string[]
  readonly regenerationCommand?: string
}

type ProjectionDefinition = {
  readonly buck2LoadLabelPrefix: string
  readonly cargoLockPath: string
  readonly cargoManifestPath: string
  readonly context: ProjectionContext
  readonly generatorSourcePaths: readonly string[]
  readonly regenerationCommand: string
  readonly reindeerConfigPath: string
  readonly repo: RepoContext
  readonly thirdPartyBuckPath: string
  readonly workspaceMembers: readonly WorkspaceMember[]
  readonly workspaceRoot: string
}

/**
 * Define a Cargo projector for one repository workspace. Paths are relative to the
 * repository root anchored by `repoImportMetaUrl`, so the same implementation works from a
 * composed consumer root and from an install-free source export.
 */
export const defineCargoBuck2PackageProjection = ({
  repoName,
  repoImportMetaUrl,
  workspaceRoot: configuredWorkspaceRoot,
  cargoManifestPath: configuredCargoManifestPath,
  cargoLockPath: configuredCargoLockPath,
  reindeerConfigPath: configuredReindeerConfigPath,
  workspaceMemberManifestPaths: configuredWorkspaceMemberManifestPaths,
  thirdPartyBuckPath: configuredThirdPartyBuckPath,
  thirdPartyPackage = '//rust/third-party',
  buck2LoadLabelPrefix = '//buck2',
  generatorSourcePaths: configuredGeneratorSourcePaths = [
    'genie/buck2/mod.ts',
    'rust/buck2-tools/core/cargo-buck2-package-projection.ts',
  ],
  regenerationCommand = 'devenv tasks run genie:run',
}: DefineCargoBuck2PackageProjectionOptions): CargoBuck2PackageProjection => {
  const repo = defineRepoContext({ name: repoName, importMetaUrl: repoImportMetaUrl })
  const workspaceRoot = validateRepoPath({
    repo,
    value: configuredWorkspaceRoot,
    field: 'workspaceRoot',
  })
  const cargoManifestPath = validateRepoPath({
    repo,
    value: configuredCargoManifestPath ?? path.posix.join(workspaceRoot, 'Cargo.toml'),
    field: 'cargoManifestPath',
  })
  const cargoLockPath = validateRepoPath({
    repo,
    value: configuredCargoLockPath ?? path.posix.join(workspaceRoot, 'Cargo.lock'),
    field: 'cargoLockPath',
  })
  const reindeerConfigPath = validateRepoPath({
    repo,
    value: configuredReindeerConfigPath ?? path.posix.join(workspaceRoot, 'reindeer.toml'),
    field: 'reindeerConfigPath',
  })
  const thirdPartyBuckPath = validateRepoPath({
    repo,
    value: configuredThirdPartyBuckPath ?? path.posix.join(workspaceRoot, 'third-party/BUCK'),
    field: 'thirdPartyBuckPath',
  })
  const reindeerConfig = Bun.TOML.parse(repo.readText(reindeerConfigPath)) as {
    readonly third_party_dir?: string
  }
  const reindeerThirdPartyDir = requireValue({
    value: reindeerConfig.third_party_dir,
    field: `${reindeerConfigPath} third_party_dir`,
  })
  if (
    path.posix.isAbsolute(reindeerThirdPartyDir) ||
    reindeerThirdPartyDir.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(reindeerThirdPartyDir)
  ) {
    throw new Error(`${reindeerConfigPath} third_party_dir must be repository-contained`)
  }
  const configuredThirdPartyPath = validateRepoPath({
    repo,
    value: path.posix.normalize(
      path.posix.join(path.posix.dirname(reindeerConfigPath), reindeerThirdPartyDir),
    ),
    field: `${reindeerConfigPath} third_party_dir`,
  })
  if (configuredThirdPartyPath !== path.posix.dirname(thirdPartyBuckPath)) {
    throw new Error('thirdPartyBuckPath must match reindeer.toml third_party_dir')
  }
  const thirdPartyPackagePath = path.posix.dirname(thirdPartyBuckPath)
  const expectedThirdPartyPackage = `//${thirdPartyPackagePath}`
  if (
    /^\/\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(thirdPartyPackage) ===
      false ||
    thirdPartyPackage !== expectedThirdPartyPackage
  ) {
    throw new Error(
      `thirdPartyPackage must be the repository-local package containing thirdPartyBuckPath: ${expectedThirdPartyPackage}`,
    )
  }
  const workspaceMemberManifestPaths = configuredWorkspaceMemberManifestPaths.map(
    (manifestPath, index) =>
      validateRepoPath({
        repo,
        value: manifestPath,
        field: `workspaceMemberManifestPaths[${index}]`,
      }),
  )
  const generatorSourcePaths = configuredGeneratorSourcePaths.map((sourcePath, index) =>
    validateRepoPath({ repo, value: sourcePath, field: `generatorSourcePaths[${index}]` }),
  )
  if (
    /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?\/\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(
      buck2LoadLabelPrefix,
    ) === false
  ) {
    throw new Error(`buck2LoadLabelPrefix is not a Buck cell/package prefix`)
  }
  if (/[\r\n]/.test(regenerationCommand)) {
    throw new Error('regenerationCommand must be a single line')
  }
  const workspaceManifest = Bun.TOML.parse(repo.readText(cargoManifestPath)) as CargoWorkspace
  const lock = Bun.TOML.parse(repo.readText(cargoLockPath)) as CargoLock
  const workspaceMembers = workspaceMemberManifestPaths.map((manifestPath) => ({
    packagePath: path.posix.dirname(manifestPath),
    manifestPath,
    manifest: Bun.TOML.parse(repo.readText(manifestPath)) as CargoManifest,
  }))
  const workspace = requireValue({ value: workspaceManifest.workspace, field: 'workspace' })
  if (workspace.resolver !== '2')
    throw new Error('The Buck projection supports only Cargo resolver = "2"')
  const declaredMemberPaths = sorted(
    requireValue({ value: workspace.members, field: 'workspace.members' }).map((member) =>
      path.posix.normalize(path.posix.join(workspaceRoot, member)),
    ),
  )
  const importedMemberPaths = sorted(workspaceMembers.map((member) => member.packagePath))
  if (JSON.stringify(declaredMemberPaths) !== JSON.stringify(importedMemberPaths)) {
    throw new Error(
      `Cargo workspace members and imported Buck projection manifests disagree: ${declaredMemberPaths.join(', ')}`,
    )
  }
  const context: ProjectionContext = {
    lockPackageNames: new Set(
      (lock.package ?? []).map((entry) =>
        requireValue({ value: entry.name, field: 'Cargo.lock package.name' }),
      ),
    ),
    memberByPath: new Map(workspaceMembers.map((member) => [member.packagePath, member])),
    repo,
    thirdPartyPackage,
    thirdPartyTargets: new Set(
      [...repo.readText(thirdPartyBuckPath).matchAll(/^    name = "([^"]+)",$/gm)].map((match) =>
        requireValue({ value: match[1], field: `${thirdPartyBuckPath} target name` }),
      ),
    ),
    workspace,
    workspaceRoot,
  }

  const definition: ProjectionDefinition = {
    buck2LoadLabelPrefix,
    cargoLockPath,
    cargoManifestPath,
    context,
    generatorSourcePaths,
    regenerationCommand,
    reindeerConfigPath,
    repo,
    thirdPartyBuckPath,
    workspaceMembers,
    workspaceRoot,
  }
  return (options) => cargoBuck2PackageProjectionFor({ definition, ...options })
}

const cargoBuck2PackageProjectionFor = ({
  definition,
  buildProduct = false,
  cliBuildStamp = false,
  sourceUrl,
}: CargoBuck2PackageProjectionOptions & {
  readonly definition: ProjectionDefinition
}): GenieOutput<unknown> => {
  const {
    buck2LoadLabelPrefix,
    cargoLockPath,
    cargoManifestPath,
    context,
    generatorSourcePaths,
    regenerationCommand,
    reindeerConfigPath,
    repo,
    thirdPartyBuckPath,
    workspaceMembers,
    workspaceRoot,
  } = definition
  const repoRoot = realpathSync(repo.rootPath)
  const projectionModulePath = validateAbsoluteRepoPath({
    repo,
    value: modulePathFromUrl(sourceUrl),
    field: 'sourceUrl',
  })
  const projectionSource = path.relative(repoRoot, projectionModulePath).replaceAll('\\', '/')
  if (path.posix.basename(projectionSource) !== 'BUCK.genie.ts') {
    throw new Error(`Cargo Buck projection source must be BUCK.genie.ts: ${projectionSource}`)
  }
  const packagePath = path.posix.dirname(projectionSource)
  const member = context.memberByPath.get(packagePath)
  if (member === undefined)
    throw new Error(`Buck projection source is not a Cargo workspace member: ${packagePath}`)
  const manifest = member.manifest
  const packageMetadata = requireValue({
    value: manifest.package,
    field: `${member.manifestPath} package`,
  })
  if (
    path.posix.normalize(path.posix.join(packagePath, packageMetadata.workspace ?? '')) !==
    workspaceRoot
  ) {
    throw new Error(
      `Cargo package ${packagePath} does not resolve workspace to ${cargoManifestPath}`,
    )
  }
  if (
    packageMetadata.version === undefined ||
    typeof packageMetadata.version === 'string' ||
    packageMetadata.version.workspace !== true
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.version`)
  }
  if (
    packageMetadata.edition === undefined ||
    typeof packageMetadata.edition === 'string' ||
    packageMetadata.edition.workspace !== true
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.edition`)
  }
  if (packageMetadata.autotests !== undefined) {
    throw new Error(`Cargo autotests overrides are unsupported in ${member.manifestPath}`)
  }
  if (
    (packageMetadata.build !== undefined && packageMetadata.build !== false) ||
    existsSync(repo.resolve(packagePath, 'build.rs')) === true
  ) {
    throw new Error(`Cargo build scripts are unsupported in ${member.manifestPath}`)
  }
  if (manifest['build-dependencies'] !== undefined) {
    throw new Error(`Cargo build dependencies are unsupported in ${member.manifestPath}`)
  }
  if (
    (manifest.test?.length ?? 0) > 0 ||
    (manifest.bench?.length ?? 0) > 0 ||
    (manifest.example?.length ?? 0) > 0
  ) {
    throw new Error(
      `Explicit Cargo test, bench, and example targets are unsupported in ${member.manifestPath}`,
    )
  }
  if (Object.keys(manifest.features ?? {}).length > 0) {
    throw new Error(`Package-defined Cargo features are unsupported in ${member.manifestPath}`)
  }

  const packageName = requireValue({
    value: packageMetadata.name,
    field: `${member.manifestPath} package.name`,
  })
  const version = requireValue({
    value: context.workspace.package?.version,
    field: 'workspace.package.version',
  })
  const edition = requireValue({
    value: context.workspace.package?.edition,
    field: 'workspace.package.edition',
  })
  const normalDependencies = resolveDependencyTable({
    context,
    member,
    dependencies: manifest.dependencies,
    field: 'dependencies',
  })
  const devDependencies = resolveDependencyTable({
    context,
    member,
    dependencies: manifest['dev-dependencies'],
    field: 'dev-dependencies',
  })
  const conditionalNormalDependencies = resolveConditionalDependencies({
    context,
    member,
    target: manifest.target,
    kind: 'dependencies',
  })
  const conditionalDevDependencies = resolveConditionalDependencies({
    context,
    member,
    target: manifest.target,
    kind: 'dev-dependencies',
  })
  const unresolvedProductionDependencies = [
    ...normalDependencies,
    ...conditionalNormalDependencies.map((entry) => entry.dependency),
  ].filter((dependency) => dependency.targetAvailable === false)
  if (unresolvedProductionDependencies.length > 0) {
    throw new Error(
      `${thirdPartyBuckPath} is missing production targets: ${sorted(
        unresolvedProductionDependencies.map((dependency) => dependency.name),
      ).join(', ')}`,
    )
  }
  const sources = discoverRustSources({ packagePath, repo })
  const { binaries, library } = discoverCargoTargets({ member, packageName, sources })
  const binaryRuleSources = new Map(
    binaries.map((binary) => [binary.name, binaryTargetSources({ binary, sources })]),
  )
  const binaryOwnedSources = new Set([...binaryRuleSources.values()].flat())
  const srcSources = sources.filter((source) => source.startsWith('src/'))
  const librarySources = srcSources.filter((source) => binaryOwnedSources.has(source) === false)
  const integrationTestRoots = sources.filter(
    (source) =>
      source.startsWith('tests/') && source.slice('tests/'.length).includes('/') === false,
  )
  const normalLabels = normalDependencies.map((dependency) => dependency.label)
  const workspaceContractSources = sorted(['BUCK', 'BUCK.genie.ts', 'Cargo.toml', ...sources])
  const compileEnv = {
    CARGO_PKG_NAME: packageName,
    CARGO_PKG_VERSION: version,
  }

  const semanticInputPaths = sorted([
    ...generatorSourcePaths,
    cargoManifestPath,
    cargoLockPath,
    reindeerConfigPath,
    thirdPartyBuckPath,
    ...workspaceMembers.map((workspaceMember) => workspaceMember.manifestPath),
    projectionSource,
    `${packagePath}/src/**/*.rs`,
    `${packagePath}/tests/**/*.rs`,
  ])
  const graphFingerprints = Object.fromEntries(
    semanticInputPaths
      .filter((input) => input.endsWith('/**/*.rs') === false && input.endsWith('.ts') === false)
      .map((input) => [input, sha256(repo.readText(input))]),
  )
  const semanticData = {
    binaries,
    compileEnv,
    cliBuildStamp,
    conditionalDevDependencies,
    conditionalNormalDependencies,
    devDependencies,
    edition,
    graphFingerprints,
    integrationTestRoots,
    library,
    librarySources,
    normalDependencies,
    packageName,
    packagePath,
    sources,
    version,
    buildProduct,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator,
    schemaVersion,
    semanticData,
  })

  const commonRuleLines = [
    `    edition = ${starlarkString(edition)},`,
    '    env = {',
    ...Object.entries(compileEnv).map(
      ([name, value]) => `        ${starlarkString(name)}: ${starlarkString(value)},`,
    ),
    ...(cliBuildStamp === true
      ? ['        "CLI_BUILD_STAMP": read_config("build_identity", "cli_build_stamp", ""),']
      : []),
    '    },',
  ]
  const normalConditional = conditionalNormalDependencies
  const renderRule = ({
    rule,
    name,
    crate,
    crateRoot,
    ruleSources,
    dependencies,
    conditionalDependencies,
    visibility,
  }: {
    readonly rule: 'rust_binary' | 'rust_library'
    readonly name: string
    readonly crate: string
    readonly crateRoot: string
    readonly ruleSources: readonly string[]
    readonly dependencies: readonly string[]
    readonly conditionalDependencies: readonly ConditionalDependency[]
    readonly visibility?: readonly string[]
  }): readonly string[] => [
    `native.${rule}(`,
    `    name = ${starlarkString(name)},`,
    `    crate = ${starlarkString(crate)},`,
    `    crate_root = ${starlarkString(crateRoot)},`,
    ...renderStringList({ name: 'srcs', values: ruleSources }),
    ...renderDependencies({ unconditional: dependencies, conditional: conditionalDependencies }),
    ...commonRuleLines,
    ...(visibility === undefined
      ? []
      : renderStringList({ name: 'visibility', values: visibility })),
    ')',
    '',
  ]

  const rules: string[] = []
  if (library !== undefined) {
    rules.push(
      ...renderRule({
        rule: 'rust_library',
        name: 'lib',
        crate: library.name,
        crateRoot: library.path,
        ruleSources: librarySources,
        dependencies: normalLabels,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  for (const binary of binaries) {
    const binaryDependencies = sorted([...normalLabels, ...(library === undefined ? [] : [':lib'])])
    rules.push(
      ...renderRule({
        rule: 'rust_binary',
        name: binary.name,
        crate: crateIdentifier(binary.name),
        crateRoot: binary.crateRoot,
        ruleSources: requireValue({
          value: binaryRuleSources.get(binary.name),
          field: `${member.manifestPath} bin ${binary.name} sources`,
        }),
        dependencies: binaryDependencies,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  if (buildProduct === true) {
    // A product package in another cell than the rules must name the rules
    // cell: a label attribute resolves in the calling package's cell.
    const rulesCell = buck2LoadLabelPrefix.match(/^@([A-Za-z0-9][A-Za-z0-9._-]*)\/\//)?.[1]
    const hostPlatform =
      rulesCell === undefined
        ? 'host_platform_label()'
        : `host_platform_label(cell = ${starlarkString(rulesCell)})`
    if (binaries.length !== 1) {
      throw new Error(
        `BuildProduct projection requires exactly one binary in ${member.manifestPath}`,
      )
    }
    const binary = requireValue({ value: binaries[0], field: `${member.manifestPath} binary` })
    rules.push(
      `rust_product_executable(`,
      `    name = ${starlarkString(`${packageName}-product-executable`)},`,
      `    binary = ${starlarkString(`:${binary.name}`)},`,
      `    recipe = ${starlarkString(`cargo-workspace:${packageName}@${version}`)},`,
      `    target_platform = ${hostPlatform},`,
      ')',
      '',
      'build_product(',
      `    name = ${starlarkString(`${packageName}-product`)},`,
      `    entrypoint = ${starlarkString(`bin/${packageName}`)},`,
      `    executable = ${starlarkString(`:${packageName}-product-executable`)},`,
      `    product_name = ${starlarkString(packageName)},`,
      `    target_platform = ${hostPlatform},`,
      ')',
      '',
    )
  }

  const rendered = [
    `# Projection source: ${projectionSource}`,
    `# Projection schema version: ${schemaVersion}`,
    `# Projection generator: ${generator}`,
    `# Semantic fingerprint: ${fingerprint}`,
    `# Semantic inputs: ${semanticInputPaths.join(', ')}`,
    `# Regenerate: ${regenerationCommand}`,
    '',
    'load("@prelude//:prelude.bzl", "native")',
    `load(${starlarkString(`${buck2LoadLabelPrefix}:static_checks.bzl`)}, "static_source_set")`,
    ...(buildProduct === true
      ? [
          `load(${starlarkString(`${buck2LoadLabelPrefix}/products:defs.bzl`)}, "build_product")`,
          `load(${starlarkString(`${buck2LoadLabelPrefix}/platforms:defs.bzl`)}, "host_platform_label")`,
          `load(${starlarkString(`${buck2LoadLabelPrefix}/rust:defs.bzl`)}, "rust_product_executable")`,
        ]
      : []),
    'static_source_set(',
    '    name = "static_sources",',
    `    prefix = ${starlarkString(packagePath)},`,
    ...renderStringList({
      name: 'srcs',
      values: workspaceContractSources,
      suffix: ' + glob(["rust-toolchain.toml"])',
    }),
    '    visibility = ["PUBLIC"],',
    ')',
    '',
    ...rules,
  ].join('\n')

  return createGenieOutput({ data: semanticData, stringify: () => rendered })
}

const generator = 'effect-utils/rust/cargo-buck2-package-projection' as const
const schemaVersion = 1 as const

const compareStrings = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)
const sorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].toSorted((left, right) => compareStrings({ left, right }))
const starlarkString = (value: string): string => JSON.stringify(value)
const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const validateAbsoluteRepoPath = ({
  repo,
  value,
  field,
}: {
  readonly repo: RepoContext
  readonly value: string
  readonly field: string
}): string => {
  const repoRoot = realpathSync(repo.rootPath)
  const resolved = realpathSync(value)
  const relative = path.relative(repoRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} resolves outside the repository: ${value}`)
  }
  return resolved
}

const validateRepoPath = ({
  repo,
  value,
  field,
}: {
  readonly repo: RepoContext
  readonly value: string
  readonly field: string
}): string => {
  if (
    value === '' ||
    path.posix.isAbsolute(value) ||
    value.includes('\\') ||
    path.posix.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must be a normalized repository-relative path: ${value}`)
  }
  validateAbsoluteRepoPath({ repo, value: repo.resolve(value), field })
  return value
}

const requireValue = <TValue>({
  value,
  field,
}: {
  readonly value: TValue | undefined
  readonly field: string
}): TValue => {
  if (value === undefined) throw new Error(`Cargo metadata is missing ${field}`)
  return value
}

const assertKnownKeys = ({
  value,
  allowed,
  field,
}: {
  readonly value: Readonly<Record<string, unknown>>
  readonly allowed: readonly string[]
  readonly field: string
}): void => {
  const unexpected = Object.keys(value).filter((key) => allowed.includes(key) === false)
  if (unexpected.length > 0) {
    throw new Error(
      `Unsupported Cargo keys at ${field}: ${unexpected.toSorted((left, right) => compareStrings({ left, right })).join(', ')}`,
    )
  }
}

type CargoDependencyRequest =
  | string
  | {
      readonly 'default-features'?: boolean
      readonly features?: readonly string[]
      readonly optional?: boolean
      readonly package?: string
      readonly path?: string
      readonly version?: string
      readonly workspace?: boolean
    }

type CargoTargetDependencies = {
  readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'dev-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'build-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
}

type CargoManifest = {
  readonly package?: {
    readonly name?: string
    readonly workspace?: string
    readonly version?: string | { readonly workspace?: boolean }
    readonly edition?: string | { readonly workspace?: boolean }
    readonly build?: boolean | string
    readonly autobins?: boolean
    readonly autolib?: boolean
    readonly autotests?: boolean
  }
  readonly lib?: {
    readonly name?: string
    readonly path?: string
    readonly 'crate-type'?: readonly string[]
    readonly 'proc-macro'?: boolean
  }
  readonly bin?: readonly {
    readonly name?: string
    readonly path?: string
    readonly 'required-features'?: readonly string[]
  }[]
  readonly test?: readonly unknown[]
  readonly bench?: readonly unknown[]
  readonly example?: readonly unknown[]
  readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'dev-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'build-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly features?: Readonly<Record<string, readonly string[]>>
  readonly target?: Readonly<Record<string, CargoTargetDependencies>>
}

type CargoWorkspace = {
  readonly workspace?: {
    readonly resolver?: string
    readonly members?: readonly string[]
    readonly package?: {
      readonly version?: string
      readonly edition?: string
    }
    readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  }
}

type CargoLock = {
  readonly package?: readonly {
    readonly name?: string
    readonly version?: string
    readonly source?: string
  }[]
}

type WorkspaceMember = {
  readonly packagePath: string
  readonly manifestPath: string
  readonly manifest: CargoManifest
}

type ProjectionContext = {
  readonly lockPackageNames: ReadonlySet<string>
  readonly memberByPath: ReadonlyMap<string, WorkspaceMember>
  readonly repo: RepoContext
  readonly thirdPartyPackage: string
  readonly thirdPartyTargets: ReadonlySet<string>
  readonly workspace: NonNullable<CargoWorkspace['workspace']>
  readonly workspaceRoot: string
}

const normalizeDependencyRequest = ({
  dependencyName,
  request,
  field,
}: {
  readonly dependencyName: string
  readonly request: CargoDependencyRequest
  readonly field: string
}): {
  readonly defaultFeatures: boolean
  readonly features: readonly string[]
  readonly path?: string
  readonly version?: string
  readonly workspace: boolean
} => {
  if (typeof request === 'string') {
    if (request.length === 0) throw new Error(`Empty Cargo version request at ${field}`)
    return { defaultFeatures: true, features: [], version: request, workspace: false }
  }
  assertKnownKeys({
    value: request,
    allowed: [
      'default-features',
      'features',
      'optional',
      'package',
      'path',
      'version',
      'workspace',
    ],
    field,
  })
  if (request.package !== undefined) {
    throw new Error(
      `Unsupported renamed Cargo dependency at ${field}: ${dependencyName} -> ${request.package}`,
    )
  }
  if (request.optional === true)
    throw new Error(`Unsupported optional Cargo dependency at ${field}`)
  if (request.workspace === true && request.path !== undefined) {
    throw new Error(`Cargo dependency at ${field} cannot combine workspace and path`)
  }
  if (request.workspace !== true && request.path === undefined && request.version === undefined) {
    throw new Error(`Cargo dependency at ${field} has no version, path, or workspace inheritance`)
  }
  return {
    defaultFeatures: request['default-features'] ?? true,
    features: sorted(request.features ?? []),
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.version === undefined ? {} : { version: request.version }),
    workspace: request.workspace === true,
  }
}

type ResolvedDependency = {
  readonly defaultFeatures: boolean
  readonly features: readonly string[]
  readonly label: string
  readonly name: string
  readonly requestSource: 'member' | 'workspace'
  readonly targetAvailable: boolean
  readonly version?: string
}

const resolveDependency = ({
  context,
  member,
  dependencyName,
  request,
  field,
}: {
  readonly context: ProjectionContext
  readonly member: WorkspaceMember
  readonly dependencyName: string
  readonly request: CargoDependencyRequest
  readonly field: string
}): ResolvedDependency => {
  const memberRequest = normalizeDependencyRequest({ dependencyName, request, field })
  if (memberRequest.path !== undefined) {
    return resolveMemberPathDependency({
      context,
      dependencyName,
      dependencyPath: path.posix.normalize(path.posix.join(member.packagePath, memberRequest.path)),
      field,
      request: memberRequest,
      requestSource: 'member',
    })
  }

  let effectiveRequest = memberRequest
  let requestSource: ResolvedDependency['requestSource'] = 'member'
  if (memberRequest.workspace === true) {
    const inheritedRequest = requireValue({
      value: context.workspace.dependencies?.[dependencyName],
      field: `workspace.dependencies.${dependencyName}`,
    })
    const normalizedInherited = normalizeDependencyRequest({
      dependencyName,
      request: inheritedRequest,
      field: `workspace.dependencies.${dependencyName}`,
    })
    if (normalizedInherited.workspace === true) {
      throw new Error(`Unsupported nested workspace dependency for ${dependencyName}`)
    }
    effectiveRequest = {
      defaultFeatures: normalizedInherited.defaultFeatures && memberRequest.defaultFeatures,
      features: sorted([...normalizedInherited.features, ...memberRequest.features]),
      ...(normalizedInherited.version === undefined
        ? {}
        : { version: normalizedInherited.version }),
      workspace: false,
    }
    if (normalizedInherited.path !== undefined) {
      // Cargo resolves `[workspace.dependencies]` paths against the workspace root.
      return resolveMemberPathDependency({
        context,
        dependencyName,
        dependencyPath: path.posix.normalize(
          path.posix.join(context.workspaceRoot, normalizedInherited.path),
        ),
        field,
        request: effectiveRequest,
        requestSource: 'workspace',
      })
    }
    requestSource = 'workspace'
  }

  if (context.lockPackageNames.has(dependencyName) === false) {
    throw new Error(`Cargo.lock has no package for dependency ${dependencyName} at ${field}`)
  }
  return {
    defaultFeatures: effectiveRequest.defaultFeatures,
    features: effectiveRequest.features,
    label: `${context.thirdPartyPackage}:${dependencyName}`,
    name: dependencyName,
    requestSource,
    targetAvailable: context.thirdPartyTargets.has(dependencyName),
    ...(effectiveRequest.version === undefined ? {} : { version: effectiveRequest.version }),
  }
}

const resolveMemberPathDependency = ({
  context,
  dependencyName,
  dependencyPath,
  field,
  request,
  requestSource,
}: {
  readonly context: ProjectionContext
  readonly dependencyName: string
  readonly dependencyPath: string
  readonly field: string
  readonly request: {
    readonly defaultFeatures: boolean
    readonly features: readonly string[]
    readonly version?: string
  }
  readonly requestSource: ResolvedDependency['requestSource']
}): ResolvedDependency => {
  const dependencyMember = context.memberByPath.get(dependencyPath)
  if (dependencyMember === undefined) {
    throw new Error(
      `Cargo path dependency at ${field} is not a workspace member: ${dependencyPath}`,
    )
  }
  const dependencyPackage = requireValue({
    value: dependencyMember.manifest.package,
    field: `${dependencyMember.manifestPath} package`,
  })
  if (dependencyPackage.name !== dependencyName) {
    throw new Error(
      `Cargo path dependency rename is unsupported at ${field}: ${dependencyName} -> ${String(dependencyPackage.name)}`,
    )
  }
  const dependencyTargets = discoverCargoTargets({
    member: dependencyMember,
    packageName: dependencyName,
    sources: discoverRustSources({ packagePath: dependencyPath, repo: context.repo }),
  })
  if (dependencyTargets.library === undefined) {
    throw new Error(`Cargo path dependency at ${field} does not expose the contracted :lib target`)
  }
  return {
    defaultFeatures: request.defaultFeatures,
    features: request.features,
    label: `//${dependencyPath}:lib`,
    name: dependencyName,
    requestSource,
    targetAvailable: true,
    ...(request.version === undefined ? {} : { version: request.version }),
  }
}

const resolveDependencyTable = ({
  context,
  member,
  dependencies,
  field,
}: {
  readonly context: ProjectionContext
  readonly member: WorkspaceMember
  readonly dependencies: Readonly<Record<string, CargoDependencyRequest>> | undefined
  readonly field: string
}): readonly ResolvedDependency[] =>
  Object.entries(dependencies ?? {})
    .map(([dependencyName, request]) =>
      resolveDependency({
        context,
        member,
        dependencyName,
        request,
        field: `${field}.${dependencyName}`,
      }),
    )
    .toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))

type CargoLibraryTarget = { readonly name: string; readonly path: string }
type CargoBinaryTarget = { readonly crateRoot: string; readonly name: string }

/**
 * Cargo target discovery for one package: explicit `[lib]`/`[[bin]]` entries with Cargo's
 * inferred defaults (`src/lib.rs`, `src/main.rs`, `src/bin/*.rs`, `src/bin/<name>/main.rs`),
 * honoring `autolib`/`autobins = false`. Explicit targets keep manifest order; inferred
 * binaries follow sorted by name, skipped when an explicit binary claims their name or path.
 */
const discoverCargoTargets = ({
  member,
  packageName,
  sources,
}: {
  readonly member: WorkspaceMember
  readonly packageName: string
  readonly sources: readonly string[]
}): { readonly binaries: readonly CargoBinaryTarget[]; readonly library?: CargoLibraryTarget } => {
  const manifest = member.manifest
  const sourceSet = new Set(sources)
  const autoTarget = (key: 'autobins' | 'autolib'): boolean => {
    const value = manifest.package?.[key] ?? true
    if (typeof value !== 'boolean') {
      throw new Error(`Cargo ${key} must be a boolean in ${member.manifestPath}`)
    }
    return value
  }
  const autolib = autoTarget('autolib')
  const autobins = autoTarget('autobins')

  const explicitLibrary = manifest.lib
  if (explicitLibrary?.['proc-macro'] === true || explicitLibrary?.['crate-type'] !== undefined) {
    throw new Error(
      `Cargo proc-macro and crate-type library semantics are unsupported in ${member.manifestPath}`,
    )
  }
  const defaultLibraryPath = 'src/lib.rs'
  let library: CargoLibraryTarget | undefined
  if (explicitLibrary !== undefined) {
    const libraryPath = explicitLibrary.path ?? defaultLibraryPath
    if (sourceSet.has(libraryPath) === false) {
      throw new Error(
        explicitLibrary.path === undefined
          ? `Cargo [lib] without path needs ${defaultLibraryPath} in ${member.manifestPath}`
          : `Cargo library path is not a discovered Rust source: ${libraryPath}`,
      )
    }
    library = { name: explicitLibrary.name ?? crateIdentifier(packageName), path: libraryPath }
  } else if (autolib === true && sourceSet.has(defaultLibraryPath) === true) {
    library = { name: crateIdentifier(packageName), path: defaultLibraryPath }
  }

  const inferableBinaries: CargoBinaryTarget[] = [
    ...(sourceSet.has('src/main.rs') === true
      ? [{ crateRoot: 'src/main.rs', name: packageName }]
      : []),
    ...sources.flatMap((source) => {
      const match = source.match(/^src\/bin\/(?:([^/]+)\.rs|([^/]+)\/main\.rs)$/)
      if (match === null) return []
      const name = requireValue({ value: match[1] ?? match[2], field: `${source} binary name` })
      return [{ crateRoot: source, name }]
    }),
  ]
  const inferableNames = inferableBinaries.map((binary) => binary.name)
  const ambiguousNames = inferableNames.filter(
    (name, index) => inferableNames.indexOf(name) !== index,
  )
  if (ambiguousNames.length > 0) {
    throw new Error(
      `Cargo binary target discovery is ambiguous in ${member.manifestPath}: ${sorted(ambiguousNames).join(', ')}`,
    )
  }

  const explicitBinaries = (manifest.bin ?? []).map((binary, index) => {
    if ((binary['required-features']?.length ?? 0) > 0) {
      throw new Error(`Cargo binary required-features are unsupported at bin[${index}]`)
    }
    const name = requireValue({ value: binary.name, field: `bin[${index}].name` })
    const crateRoot =
      binary.path ??
      inferableBinaries.find((candidate) => candidate.name === name)?.crateRoot ??
      requireValue<string>({
        value: undefined,
        field: `bin[${index}].path (no src/bin/${name}.rs, src/bin/${name}/main.rs, or src/main.rs for the package binary)`,
      })
    if (sourceSet.has(crateRoot) === false) {
      throw new Error(`Cargo binary path is not a discovered Rust source: ${crateRoot}`)
    }
    return { crateRoot, name }
  })
  const explicitNames = new Set(explicitBinaries.map((binary) => binary.name))
  const explicitRoots = new Set(explicitBinaries.map((binary) => binary.crateRoot))
  const binaries = [
    ...explicitBinaries,
    ...(autobins === true
      ? inferableBinaries
          .filter(
            (binary) =>
              explicitNames.has(binary.name) === false &&
              explicitRoots.has(binary.crateRoot) === false,
          )
          .toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
      : []),
  ]
  if (library === undefined && binaries.length === 0) {
    throw new Error(`Cargo package ${member.packagePath} has no library or binary target`)
  }
  if (new Set(binaries.map((binary) => binary.name)).size !== binaries.length) {
    throw new Error(`Cargo package ${member.packagePath} has duplicate binary names`)
  }
  const crateRoots = [
    ...(library === undefined ? [] : [library.path]),
    ...binaries.map((binary) => binary.crateRoot),
  ]
  const sharedRoots = crateRoots.filter((root, index) => crateRoots.indexOf(root) !== index)
  if (sharedRoots.length > 0) {
    throw new Error(
      `Cargo targets share a crate root in ${member.manifestPath}: ${sorted(sharedRoots).join(', ')}`,
    )
  }
  return library === undefined ? { binaries } : { binaries, library }
}

/** A `src/bin/<name>/main.rs` binary owns its directory's modules; any other binary owns its root. */
const binaryTargetSources = ({
  binary,
  sources,
}: {
  readonly binary: CargoBinaryTarget
  readonly sources: readonly string[]
}): readonly string[] => {
  const directoryMatch = binary.crateRoot.match(/^(src\/bin\/[^/]+\/)main\.rs$/)
  if (directoryMatch === null) return [binary.crateRoot]
  const directory = requireValue({
    value: directoryMatch[1],
    field: `${binary.crateRoot} directory`,
  })
  return sources.filter((source) => source.startsWith(directory))
}

const discoverRustSources = ({
  packagePath,
  repo,
}: {
  readonly packagePath: string
  readonly repo: RepoContext
}): readonly string[] => {
  const packageRoot = repo.resolve(packagePath)
  const sources: string[] = []
  const walk = (relativeDirectory: string): void => {
    for (const entry of readdirSync(path.join(packageRoot, relativeDirectory), {
      withFileTypes: true,
    }).toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Rust source census refuses symlink: ${packagePath}/${relativePath}`)
      }
      if (entry.isDirectory() === true) walk(relativePath)
      else if (entry.isFile() === true && path.extname(entry.name) === '.rs')
        sources.push(relativePath)
    }
  }
  walk('src')
  if (existsSync(path.join(packageRoot, 'tests')) === true) walk('tests')
  if (sources.length === 0) throw new Error(`Rust source census found no inputs in ${packagePath}`)
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

const targetConditionLabels = (condition: string): readonly string[] => {
  switch (condition) {
    case 'cfg(unix)':
      return ['prelude//os/constraints:linux', 'prelude//os/constraints:macos']
    case 'cfg(target_os = "linux")':
      return ['prelude//os/constraints:linux']
    case 'cfg(target_os = "macos")':
      return ['prelude//os/constraints:macos']
    default:
      throw new Error(`Unsupported Cargo target dependency condition: ${condition}`)
  }
}

type ConditionalDependency = {
  readonly condition: string
  readonly dependency: ResolvedDependency
  readonly selectLabels: readonly string[]
}

const resolveConditionalDependencies = ({
  context,
  member,
  target,
  kind,
}: {
  readonly context: ProjectionContext
  readonly member: WorkspaceMember
  readonly target: CargoManifest['target']
  readonly kind: 'dependencies' | 'dev-dependencies'
}): readonly ConditionalDependency[] =>
  Object.entries(target ?? {})
    .flatMap(([condition, tables]) => {
      assertKnownKeys({
        value: tables,
        allowed: ['dependencies', 'dev-dependencies', 'build-dependencies'],
        field: `target.${condition}`,
      })
      if (tables['build-dependencies'] !== undefined) {
        throw new Error(`Cargo target build dependencies are unsupported at target.${condition}`)
      }
      const selectLabels = targetConditionLabels(condition)
      return resolveDependencyTable({
        context,
        member,
        dependencies: tables[kind],
        field: `target.${condition}.${kind}`,
      }).map((dependency) => ({ condition, dependency, selectLabels }))
    })
    .toSorted((left, right) =>
      compareStrings({
        left: `${left.condition}:${left.dependency.name}`,
        right: `${right.condition}:${right.dependency.name}`,
      }),
    )

const renderStringList = ({
  name,
  values,
  suffix = '',
}: {
  readonly name: string
  readonly values: readonly string[]
  readonly suffix?: string
}): readonly string[] => [
  `    ${name} = [`,
  ...values.map((value) => `        ${starlarkString(value)},`),
  `    ]${suffix},`,
]

const renderDependencies = ({
  unconditional,
  conditional,
}: {
  readonly unconditional: readonly string[]
  readonly conditional: readonly ConditionalDependency[]
}): readonly string[] => {
  const base = sorted(unconditional)
  const selected = new Map<string, string[]>()
  for (const entry of conditional) {
    if (base.includes(entry.dependency.label) === true) continue
    for (const selectLabel of entry.selectLabels) {
      const labels = selected.get(selectLabel) ?? []
      labels.push(entry.dependency.label)
      selected.set(selectLabel, labels)
    }
  }
  const baseLines = renderStringList({ name: 'deps', values: base })
  if (selected.size === 0) return baseLines
  return [
    ...baseLines.slice(0, -1),
    '    ] + select({',
    ...[...selected.entries()]
      .toSorted(([left], [right]) => compareStrings({ left, right }))
      .flatMap(([selectLabel, labels]) =>
        [`        ${starlarkString(selectLabel)}: [`].concat(
          sorted(labels).map((label) => `            ${starlarkString(label)},`),
          '        ],',
        ),
      ),
    '        "DEFAULT": [],',
    '    }),',
  ]
}

const crateIdentifier = (value: string): string => value.replaceAll(/[^A-Za-z0-9_]/g, '_')

const effectUtilsWorkspaceMemberManifestPaths = [
  'packages/@overeng/otel-scrape/Cargo.toml',
  'packages/@overeng/otelite/Cargo.toml',
  'rust/buck2-tools/archive-tool/Cargo.toml',
  'rust/buck2-tools/core/Cargo.toml',
  'rust/buck2-tools/events/Cargo.toml',
  'rust/buck2-tools/product/Cargo.toml',
] as const

/** Repository-relative paths of effect-utils Cargo workspace members governed by the projection. */
export const cargoBuck2WorkspaceMemberPaths = effectUtilsWorkspaceMemberManifestPaths.map(
  (manifestPath) => path.posix.dirname(manifestPath),
)

/** Effect-utils' byte-stable default Cargo projection. */
export const cargoBuck2PackageProjection = defineCargoBuck2PackageProjection({
  repoName: 'effect-utils',
  repoImportMetaUrl: import.meta.url,
  workspaceRoot: 'rust',
  workspaceMemberManifestPaths: effectUtilsWorkspaceMemberManifestPaths,
})
