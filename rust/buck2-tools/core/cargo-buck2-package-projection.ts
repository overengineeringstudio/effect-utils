import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
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

/** One Buck product emitted from a named Cargo binary of the projected package. */
export type CargoBuck2ProductOptions = {
  /** Product name; emits `<name>-product-executable` and `<name>-product`. */
  readonly name: string
  /** Cargo binary target packaged by the product; defaults to `name`. */
  readonly binary?: string
  /** Payload-relative executable path; defaults to `bin/<name>`. */
  readonly entrypoint?: string
}

/** One smoke target per runtime, each named `<product>-smoke-<runtime>`. */
export type CargoBuck2InteropSmokeOptions = {
  readonly script: string
  readonly runtimes: readonly ('node' | 'bun')[]
}

/** Size profile overrides for a wasm product; omitted fields keep the fleet defaults. */
export type CargoBuck2WasmProfile = {
  readonly optLevel?: '0' | '1' | '2' | '3' | 's' | 'z'
  readonly lto?: 'fat' | 'thin' | 'off'
  readonly strip?: 'symbols' | 'debuginfo' | 'none'
}

/** Glue and conditional package outputs for the package's Cargo cdylib. */
export type CargoBuck2WasmBindgenOptions = {
  readonly name: string
  readonly outName?: string
  readonly profile?: CargoBuck2WasmProfile
  readonly smoke?: CargoBuck2InteropSmokeOptions
  readonly visibility?: readonly string[]
}

/** Raw wasm32 guest product for one declared host harness. */
export type CargoBuck2WasmGuestOptions = {
  readonly name: string
  readonly productName: string
  readonly entrypoint: string
  readonly harness: string
  readonly recipe: string
  readonly toolchain: string
}

/** Node-API addon output for the package's Cargo cdylib. */
export type CargoBuck2NapiOptions = {
  readonly name: string
  readonly smoke?: CargoBuck2InteropSmokeOptions
  readonly visibility?: readonly string[]
}

/** Package products, interop outputs, and build inputs projected from Cargo into Buck2. */
export type CargoBuck2PackageProjectionOptions = {
  /** One product named after the package from its only binary. Exclusive with `buildProducts`. */
  readonly buildProduct?: boolean
  /** Several products from one package, one per named Cargo binary. */
  readonly buildProducts?: readonly CargoBuck2ProductOptions[]
  readonly cliBuildStamp?: boolean
  readonly wasmBindgen?: CargoBuck2WasmBindgenOptions
  readonly napi?: CargoBuck2NapiOptions
  readonly wasmGuest?: CargoBuck2WasmGuestOptions
  /**
   * Files the package's build script reads besides the package's Rust sources, by
   * repository-relative path. A file in another Buck package names the label providing it
   * (for example an `export_file`); a file inside the package needs no label. The build
   * script sees each at its repository layout relative to `CARGO_MANIFEST_DIR`.
   */
  readonly buildScriptInputs?: readonly CargoBuck2BuildScriptInput[]
  /** Explicit rustc inputs, separate from build-script inputs; no macro scanning. */
  readonly compileTimeResources?: readonly CargoBuck2CompileTimeResource[]
  readonly sourceUrl: string
}

/** One declared build script input; see `buildScriptInputs`. */
export type CargoBuck2BuildScriptInput = {
  readonly path: string
  readonly label?: string
}

/** Local paths are repository-relative. Destinations are normalized crate-relative paths. */
export type CargoBuck2CompileTimeResource =
  | { readonly path: string; readonly destination?: string; readonly label?: never }
  | { readonly label: string; readonly destination: string; readonly path?: string }

/** Renders a package's Buck2 output using a configured Cargo workspace projection. */
export type CargoBuck2PackageProjection = (
  options: CargoBuck2PackageProjectionOptions,
) => GenieOutput<unknown>

/** Repository and workspace inputs used to configure a Cargo-to-Buck2 package projection. */
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
  /** Workspace-wide Cargo feature unification, computed on first render. */
  readonly featureResolution: () => ReadonlyMap<string, MemberFeatureState>
  readonly foreignPackages: readonly WorkspaceMember[]
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
    readonly cargo_env?: boolean
  }
  const reindeerThirdPartyDir = requireValue({
    value: reindeerConfig.third_party_dir,
    field: `${reindeerConfigPath} third_party_dir`,
  })
  if (reindeerConfig.cargo_env !== true) {
    throw new Error(`${reindeerConfigPath} must set root-level cargo_env = true`)
  }
  if (
    path.posix.isAbsolute(reindeerThirdPartyDir) === true ||
    reindeerThirdPartyDir.includes('\\') === true ||
    // oxlint-disable-next-line no-control-regex -- Repository paths must reject ASCII control characters.
    /[\u0000-\u001f\u007f]/.test(reindeerThirdPartyDir) === true
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
  const cargoResolutionPath = `${thirdPartyPackagePath}/cargo-resolution.json`
  const cargoResolution: CargoResolution | undefined =
    existsSync(repo.resolve(cargoResolutionPath)) === true
      ? (JSON.parse(repo.readText(cargoResolutionPath)) as CargoResolution)
      : undefined
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
  if (/[\r\n]/.test(regenerationCommand) === true) {
    throw new Error('regenerationCommand must be a single line')
  }
  const foreignPackagesPath = path.posix.join(workspaceRoot, 'foreign-packages.json')
  const hasForeignPackagesFile = existsSync(repo.resolve(foreignPackagesPath))
  const foreignPackageManifestPaths: readonly string[] =
    hasForeignPackagesFile === true
      ? (() => {
          const declaration: unknown = JSON.parse(repo.readText(foreignPackagesPath))
          if (
            typeof declaration !== 'object' ||
            declaration === null ||
            !('foreignPackageManifestPaths' in declaration) ||
            Array.isArray(declaration.foreignPackageManifestPaths) === false ||
            declaration.foreignPackageManifestPaths.length === 0 ||
            declaration.foreignPackageManifestPaths.every((value) => typeof value === 'string') ===
              false
          ) {
            throw new Error(
              `${foreignPackagesPath} must contain nonempty foreignPackageManifestPaths: string[]`,
            )
          }
          return declaration.foreignPackageManifestPaths as string[]
        })()
      : []
  const generatorSourcePathsWithForeign =
    hasForeignPackagesFile === true
      ? [...generatorSourcePaths, foreignPackagesPath]
      : generatorSourcePaths
  const workspaceManifest = Bun.TOML.parse(repo.readText(cargoManifestPath)) as CargoWorkspace
  const lock = Bun.TOML.parse(repo.readText(cargoLockPath)) as CargoLock
  const workspaceMembers = workspaceMemberManifestPaths.map((manifestPath) => ({
    packagePath: path.posix.dirname(manifestPath),
    manifestPath,
    manifest: Bun.TOML.parse(repo.readText(manifestPath)) as CargoManifest,
  }))
  const memberPackagePaths = new Set(workspaceMembers.map((member) => member.packagePath))
  const foreignPackages = foreignPackageManifestPaths.map((configuredPath, index) => {
    const manifestPath = validateRepoPath({
      repo,
      value: configuredPath,
      field: `foreignPackageManifestPaths[${index}]`,
    })
    const packagePath = path.posix.dirname(manifestPath)
    if (memberPackagePaths.has(packagePath) === true) {
      throw new Error(`Foreign Cargo package is a member of this workspace: ${packagePath}`)
    }
    if (existsSync(repo.resolve(packagePath, 'BUCK.genie.ts')) === false) {
      throw new Error(
        `Foreign Cargo package must itself be Buck-projected (no BUCK.genie.ts): ${packagePath}`,
      )
    }
    const manifest = Bun.TOML.parse(repo.readText(manifestPath)) as CargoManifest
    const foreignWorkspaceRoot = findCargoWorkspaceRoot({ repo, packagePath, manifest })
    return {
      packagePath,
      manifestPath,
      manifest,
      workspaceRoot: foreignWorkspaceRoot,
      workspace:
        (
          Bun.TOML.parse(
            repo.readText(path.posix.join(foreignWorkspaceRoot, 'Cargo.toml')),
          ) as CargoWorkspace
        ).workspace ?? {},
    }
  })
  if (foreignPackages.length > 0 && cargoResolution === undefined) {
    throw new Error(`${cargoResolutionPath} is missing; regenerate the consumer Reindeer supply`)
  }
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
    foreignPackageByPath: new Map(foreignPackages.map((foreign) => [foreign.packagePath, foreign])),
    foreignTargetPackage: requireValue({
      value: sorted([...memberPackagePaths])[0],
      field: 'workspace member hosting foreign targets',
    }),
    cargoResolution,
    cargoResolutionPath: cargoResolution === undefined ? undefined : cargoResolutionPath,
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
    featureResolution: memoize(() => resolveWorkspaceFeatures({ context })),
    foreignPackages,
    generatorSourcePaths: generatorSourcePathsWithForeign,
    regenerationCommand,
    reindeerConfigPath,
    repo,
    thirdPartyBuckPath,
    workspaceMembers,
    workspaceRoot,
  }
  return (options) => cargoBuck2PackageProjectionFor({ definition, ...options })
}

const renderRustcFlags = (terms: readonly string[]): readonly string[] =>
  terms.length === 0 ? [] : [`    rustc_flags = ${terms.join(' + ')},`]

const cargoBuck2PackageProjectionFor = ({
  definition,
  buildProduct = false,
  buildProducts,
  buildScriptInputs,
  compileTimeResources,
  cliBuildStamp = false,
  wasmBindgen,
  wasmGuest,
  napi,
  sourceUrl,
  foreignMember,
}: CargoBuck2PackageProjectionOptions & {
  readonly definition: ProjectionDefinition
  readonly foreignMember?: WorkspaceMember
}): GenieOutput<unknown> => {
  const {
    buck2LoadLabelPrefix,
    cargoLockPath,
    cargoManifestPath,
    context: consumerContext,
    foreignPackages,
    generatorSourcePaths,
    regenerationCommand,
    reindeerConfigPath,
    repo,
    thirdPartyBuckPath,
    workspaceMembers,
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
  const packagePath = foreignMember?.packagePath ?? path.posix.dirname(projectionSource)
  const context = contextForMember({ context: consumerContext, member: foreignMember })
  const member = foreignMember ?? context.memberByPath.get(packagePath)
  if (member === undefined)
    throw new Error(`Buck projection source is not a Cargo workspace member: ${packagePath}`)
  const manifest = member.manifest
  const packageMetadata = requireValue({
    value: manifest.package,
    field: `${member.manifestPath} package`,
  })
  if (
    path.posix.normalize(path.posix.join(packagePath, packageMetadata.workspace ?? '')) !==
      context.workspaceRoot &&
    foreignMember === undefined
  ) {
    throw new Error(
      `Cargo package ${packagePath} does not resolve workspace to ${cargoManifestPath}`,
    )
  }
  if (
    foreignMember === undefined &&
    (packageMetadata.version === undefined ||
      typeof packageMetadata.version === 'string' ||
      packageMetadata.version.workspace !== true)
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.version`)
  }
  if (
    foreignMember === undefined &&
    (packageMetadata.edition === undefined ||
      typeof packageMetadata.edition === 'string' ||
      packageMetadata.edition.workspace !== true)
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.edition`)
  }
  if (packageMetadata.autotests !== undefined) {
    throw new Error(`Cargo autotests overrides are unsupported in ${member.manifestPath}`)
  }
  const buildScript = resolveBuildScript({
    buildScriptInputs,
    member,
    packagePath,
    repo,
  })
  if (
    (manifest.test?.length ?? 0) > 0 ||
    (manifest.bench?.length ?? 0) > 0 ||
    (manifest.example?.length ?? 0) > 0
  ) {
    throw new Error(
      `Explicit Cargo test, bench, and example targets are unsupported in ${member.manifestPath}`,
    )
  }

  const packageName = requireValue({
    value: packageMetadata.name,
    field: `${member.manifestPath} package.name`,
  })
  const version = requireValue({
    value:
      typeof packageMetadata.version === 'string'
        ? packageMetadata.version
        : context.workspace.package?.version,
    field: 'workspace.package.version',
  })
  const edition = requireValue({
    value:
      typeof packageMetadata.edition === 'string'
        ? packageMetadata.edition
        : context.workspace.package?.edition,
    field: 'workspace.package.edition',
  })
  if (edition === '2015') {
    // Edition 2015 changes Cargo's target inference (legacy paths, autobins off beside
    // explicit [[bin]]); the projection only models edition 2018+ discovery.
    throw new Error(`Cargo edition 2015 is unsupported in ${cargoManifestPath}`)
  }
  const normalDependencies = resolveDependencyTable({
    context,
    member,
    dependencies: manifest.dependencies,
    field: 'dependencies',
  })
  const devDependencies = resolveDependencyTable({
    context,
    member,
    dependencies: foreignMember === undefined ? manifest['dev-dependencies'] : undefined,
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
    target: foreignMember === undefined ? manifest.target : undefined,
    kind: 'dev-dependencies',
  })
  const featureState = definition.featureResolution().get(packagePath) ?? {
    activeOptional: new Set<string>(),
    definedFeatures: new Set<string>(),
    features: new Set<string>(),
  }
  // Optional dependencies compile only when a unified feature activates them.
  const isActive = (dependency: ResolvedDependency): boolean =>
    dependency.optional !== true || featureState.activeOptional.has(dependency.name) === true
  const activeNormalDependencies = normalDependencies.filter(isActive)
  const activeConditionalNormalDependencies = conditionalNormalDependencies.filter((entry) =>
    isActive(entry.dependency),
  )
  const enabledFeatures = sorted([...featureState.features])
  // Cargo ignores `[build-dependencies]` of a package without a build script.
  const buildDependencies =
    buildScript === undefined
      ? []
      : resolveDependencyTable({
          context,
          member,
          dependencies: manifest['build-dependencies'],
          field: 'build-dependencies',
        })
  const unsupportedBuildDependencies = buildDependencies.filter(
    (dependency) => dependency.optional === true || dependency.package !== undefined,
  )
  if (unsupportedBuildDependencies.length > 0) {
    throw new Error(
      `Optional and renamed Cargo build dependencies are unsupported in ${member.manifestPath}: ${sorted(
        unsupportedBuildDependencies.map((dependency) => dependency.name),
      ).join(', ')}`,
    )
  }
  // A member's one `:lib` compiles with the workspace's unified normal-edge features;
  // a build-dependency request (resolved separately for the host by resolver 2) would
  // silently not reach it.
  const memberBuildFeatureRequests = buildDependencies.filter(
    (dependency) =>
      dependency.label.startsWith(`${context.thirdPartyPackage}:`) === false &&
      (dependency.features.length > 0 || dependency.defaultFeatures === false),
  )
  if (memberBuildFeatureRequests.length > 0) {
    throw new Error(
      `Cargo build dependencies on first-party packages cannot request features or disable default features in ${member.manifestPath}: ${sorted(
        memberBuildFeatureRequests.map((dependency) => dependency.name),
      ).join(', ')}`,
    )
  }
  const unresolvedProductionDependencies = [
    ...activeNormalDependencies,
    ...activeConditionalNormalDependencies.map((entry) => entry.dependency),
    ...buildDependencies,
  ].filter((dependency) => dependency.targetAvailable === false)
  if (unresolvedProductionDependencies.length > 0) {
    throw new Error(
      `${thirdPartyBuckPath} is missing production targets: ${sorted(
        unresolvedProductionDependencies.map((dependency) => dependency.name),
      ).join(', ')}`,
    )
  }
  const sources = discoverRustSources({ packagePath, repo })
  const resources = resolveCompileTimeResources({
    compileTimeResources,
    packagePath,
    repo,
    sources,
  })
  const { binaries: declaredBinaries, library } = discoverCargoTargets({
    member,
    packageName,
    sources,
  })
  if (wasmBindgen !== undefined || wasmGuest !== undefined || napi !== undefined) {
    if (library?.crateTypes?.includes('cdylib') !== true) {
      throw new Error(
        `Rust interop products require Cargo [lib] crate-type to contain "cdylib" in ${member.manifestPath}`,
      )
    }
  }
  for (const binary of declaredBinaries) {
    const undefinedFeatures = (binary.requiredFeatures ?? []).filter(
      (feature) => featureState.definedFeatures.has(feature) === false,
    )
    if (undefinedFeatures.length > 0) {
      throw new Error(
        `Cargo binary ${binary.name} requires undefined features in ${member.manifestPath}: ${sorted(undefinedFeatures).join(', ')}`,
      )
    }
  }
  // Cargo skips a binary whose `required-features` the unified feature set does not enable.
  const binaries = declaredBinaries.filter((binary) =>
    (binary.requiredFeatures ?? []).every((feature) => featureState.features.has(feature)),
  )
  const products = resolveProducts({
    binaries,
    buildProduct,
    buildProducts,
    manifestPath: member.manifestPath,
    packageName,
  })
  const reservedTargetNames = new Set([
    'static_sources',
    ...(library === undefined ? [] : ['lib']),
    ...products.flatMap((product) => [
      `${product.name}-product-executable`,
      `${product.name}-product`,
    ]),
    ...(buildScript === undefined
      ? []
      : [
          `${packageName}-build-script-build`,
          `${packageName}-build-script`,
          `${packageName}-build-script-run`,
        ]),
  ])
  const collidingBinaries = binaries.filter((binary) => reservedTargetNames.has(binary.name))
  if (collidingBinaries.length > 0) {
    throw new Error(
      `Cargo binary names collide with generated Buck targets in ${member.manifestPath}: ${sorted(
        collidingBinaries.map((binary) => binary.name),
      ).join(', ')}`,
    )
  }
  // Any `src/` file can be a module of any target (`mod main;`, `mod bin;`, a peer binary's
  // root), so every Rust target declares all of them; extra srcs only widen action inputs.
  const srcSources = sources.filter((source) => source.startsWith('src/'))
  const librarySources = srcSources
  const integrationTestRoots = sources.filter(
    (source) =>
      source.startsWith('tests/') && source.slice('tests/'.length).includes('/') === false,
  )
  const renamedConditional = [...conditionalNormalDependencies, ...conditionalDevDependencies]
    .filter((entry) => entry.dependency.package !== undefined)
    .map((entry) => entry.dependency.name)
  if (renamedConditional.length > 0) {
    throw new Error(
      `Renamed target-specific Cargo dependencies are unsupported in ${member.manifestPath}: ${sorted(renamedConditional).join(', ')}`,
    )
  }
  const normalLabels = activeNormalDependencies
    .filter((dependency) => dependency.package === undefined)
    .map((dependency) => dependency.label)
  // A renamed crate keeps the registry crate name in its rule; the request name is the
  // extern name the member's code uses, which Buck binds through `named_deps`.
  const namedDependencies = activeNormalDependencies
    .filter((dependency) => dependency.package !== undefined)
    .map((dependency) => ({ label: dependency.label, name: crateIdentifier(dependency.name) }))
  const workspaceContractSources = sorted([
    'BUCK',
    'BUCK.genie.ts',
    'Cargo.toml',
    ...sources,
    ...resources
      .filter((resource) => resource.label === undefined)
      .map((resource) =>
        requireValue({ value: resource.path, field: 'local compileTimeResources path' }).slice(
          packagePath.length + 1,
        ),
      ),
    ...(buildScript === undefined
      ? []
      : [
          buildScript.path,
          ...buildScript.inputs
            .filter((input) => input.label === undefined)
            .map((input) => input.path.slice(packagePath.length + 1)),
        ]),
  ])
  // The files a consumer's foreign instance of this library reads (see foreign-packages.json).
  const instanceFiles = sorted([
    ...new Set([
      'Cargo.toml',
      ...librarySources,
      ...resources
        .filter((resource) => resource.label === undefined)
        .map((resource) =>
          requireValue({ value: resource.path, field: 'local compileTimeResources path' }).slice(
            packagePath.length + 1,
          ),
        ),
      ...(buildScript === undefined
        ? []
        : [
            buildScript.path,
            ...buildScript.inputs
              .filter((input) => input.label === undefined)
              .map((input) => input.path.slice(packagePath.length + 1)),
          ]),
    ]),
  ])
  // Cargo exposes these variables at compile time, including empty strings
  // for missing manifest fields. See the Cargo reference:
  // https://doc.rust-lang.org/cargo/reference/environment-variables.html#environment-variables-cargo-sets-for-crates
  const packageField = (field: CargoPackageTextField): string => {
    const value = packageMetadata[field]
    if (typeof value === 'string') return value
    if (value === undefined || value === false) return ''
    if (value.workspace !== true) {
      throw new Error(
        `Cargo package.${field} must inherit with workspace = true in ${member.manifestPath}`,
      )
    }
    const inherited = requireValue({
      value: context.workspace.package?.[field],
      field: `workspace.package.${field}`,
    })
    return inherited === false ? '' : inherited
  }
  let authors: readonly string[] = []
  const declaredAuthors = packageMetadata.authors
  if (declaredAuthors !== undefined) {
    if ('workspace' in declaredAuthors) {
      if (declaredAuthors.workspace !== true) {
        throw new Error(
          `Cargo package.authors must inherit with workspace = true in ${member.manifestPath}`,
        )
      }
      authors = requireValue({
        value: context.workspace.package?.authors,
        field: 'workspace.package.authors',
      })
    } else {
      authors = declaredAuthors
    }
  }
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (semver === null) {
    throw new Error(`Cargo package version ${version} is not semver in ${member.manifestPath}`)
  }
  const compileEnv = {
    CARGO_PKG_NAME: packageName,
    CARGO_PKG_VERSION: version,
    CARGO_PKG_VERSION_MAJOR: semver[1] ?? '',
    CARGO_PKG_VERSION_MINOR: semver[2] ?? '',
    CARGO_PKG_VERSION_PATCH: semver[3] ?? '',
    CARGO_PKG_VERSION_PRE: semver[4] ?? '',
    CARGO_PKG_AUTHORS: authors.join(':'),
    CARGO_PKG_DESCRIPTION: packageField('description'),
    CARGO_PKG_HOMEPAGE: packageField('homepage'),
    CARGO_PKG_REPOSITORY: packageField('repository'),
    CARGO_PKG_LICENSE: packageField('license'),
    CARGO_PKG_LICENSE_FILE: packageField('license-file'),
    CARGO_PKG_README:
      packageMetadata.readme === undefined
        ? (['README.md', 'README.txt', 'README'].find((readme) =>
            existsSync(repo.resolve(packagePath, readme)),
          ) ?? '')
        : packageField('readme'),
    CARGO_PKG_RUST_VERSION: packageField('rust-version'),
  }

  // Only the host shard renders the consumer's foreign instances.
  const hostedForeignPackages =
    foreignMember === undefined && packagePath === context.foreignTargetPackage
      ? foreignPackages
      : []
  const foreignProjections = hostedForeignPackages.map((foreign) =>
    cargoBuck2PackageProjectionFor({ definition, sourceUrl, foreignMember: foreign }),
  )
  const semanticInputPaths = sorted([
    ...generatorSourcePaths,
    cargoManifestPath,
    cargoLockPath,
    reindeerConfigPath,
    thirdPartyBuckPath,
    ...(context.cargoResolutionPath === undefined ? [] : [context.cargoResolutionPath]),
    ...workspaceMembers.map((workspaceMember) => workspaceMember.manifestPath),
    ...foreignPackages.flatMap((foreignPackage) => [
      foreignPackage.manifestPath,
      path.posix.join(
        requireValue({
          value: foreignPackage.workspaceRoot,
          field: `${foreignPackage.manifestPath} workspace root`,
        }),
        'Cargo.toml',
      ),
      `${foreignPackage.packagePath}/src/**/*.rs`,
    ]),
    projectionSource,
    `${packagePath}/src/**/*.rs`,
    `${packagePath}/tests/**/*.rs`,
    ...resources.flatMap((resource) => (resource.path === undefined ? [] : [resource.path])),
  ])
  const resourceFingerprints: Readonly<Record<string, string>> = Object.fromEntries(
    resources.flatMap((resource) =>
      resource.path === undefined || resource.fingerprint === undefined
        ? []
        : [[resource.path, resource.fingerprint]],
    ),
  )
  const graphFingerprints = Object.fromEntries(
    semanticInputPaths
      .filter((input) => input.endsWith('/**/*.rs') === false && input.endsWith('.ts') === false)
      .map((input) => [input, resourceFingerprints[input] ?? sha256(repo.readText(input))]),
  )
  const semanticData = {
    binaries,
    compileEnv,
    ...(resources.length === 0 ? {} : { compileTimeResources: resources }),
    ...(foreignProjections.length === 0
      ? {}
      : { foreignPackages: foreignProjections.map((projection) => projection.data) }),
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
    // Absent unless requested so single-product fingerprints stay byte-identical.
    ...(buildProducts === undefined ? {} : { products }),
    ...(wasmBindgen === undefined ? {} : { wasmBindgen }),
    ...(wasmGuest === undefined ? {} : { wasmGuest }),
    ...(napi === undefined ? {} : { napi }),
    // Absent for feature-free packages so their fingerprints stay byte-identical.
    ...(enabledFeatures.length === 0 ? {} : { enabledFeatures }),
    ...(featureState.activeOptional.size === 0
      ? {}
      : { activeOptionalDependencies: sorted([...featureState.activeOptional]) }),
    // Absent without a build script so script-free fingerprints stay byte-identical.
    ...(buildScript === undefined ? {} : { buildScript: { ...buildScript, buildDependencies } }),
    buildProduct,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator,
    schemaVersion,
    semanticData,
  })

  const buildScriptRun = `${packageName}-build-script-run`
  const envLines = ({
    buildScriptOutputs,
    crateName,
    binName,
  }: {
    readonly buildScriptOutputs: boolean
    readonly crateName: string
    readonly binName?: string
  }): readonly string[] => [
    '    env = {',
    ...Object.entries(compileEnv).map(
      ([name, value]) => `        ${starlarkString(name)}: ${starlarkString(value)},`,
    ),
    `        "CARGO_CRATE_NAME": ${starlarkString(crateName)},`,
    `        "CARGO_MANIFEST_DIR": ${starlarkString(packagePath)},`,
    ...(binName === undefined ? [] : [`        "CARGO_BIN_NAME": ${starlarkString(binName)},`]),
    ...(cliBuildStamp === true
      ? ['        "CLI_BUILD_STAMP": read_config("build_identity", "cli_build_stamp", ""),']
      : []),
    ...(buildScriptOutputs === true
      ? [`        "OUT_DIR": ${starlarkString(`$(location :${buildScriptRun}[out_dir])`)},`]
      : []),
    '    },',
  ]
  const featureLines =
    enabledFeatures.length === 0
      ? []
      : renderStringList({ name: 'features', values: enabledFeatures })
  const commonRuleLines = [`    edition = ${starlarkString(edition)},`, ...featureLines]
  const normalConditional = activeConditionalNormalDependencies
  const renderRule = ({
    rule,
    name,
    crate,
    crateRoot,
    ruleSources,
    dependencies,
    conditionalDependencies,
    visibility,
    procMacro = false,
  }: {
    readonly rule: 'rust_binary' | 'rust_library'
    readonly name: string
    readonly crate: string
    readonly crateRoot: string
    readonly ruleSources: readonly string[]
    readonly dependencies: readonly string[]
    readonly conditionalDependencies: readonly ConditionalDependency[]
    readonly visibility?: readonly string[]
    readonly procMacro?: boolean
  }): readonly string[] => [
    `native.${rule}(`,
    `    name = ${starlarkString(name)},`,
    `    crate = ${starlarkString(crate)},`,
    `    crate_root = ${starlarkString(crateRoot)},`,
    ...(procMacro === true ? ['    proc_macro = True,'] : []),
    ...(resources.length === 0
      ? renderSources({ name: 'srcs', values: ruleSources, foreignMember })
      : [
          '    mapped_srcs = {',
          ...ruleSources.map(
            (file) =>
              `        ${starlarkString(sourceLabel({ file, foreignMember }))}: ${starlarkString(file)},`,
          ),
          ...resources.map(
            (resource) =>
              `        ${starlarkString(
                resource.label ??
                  sourceLabel({
                    file: requireValue({
                      value: resource.path,
                      field: 'local compileTimeResources path',
                    }).slice(packagePath.length + 1),
                    foreignMember,
                  }),
              )}: ${starlarkString(resource.destination)},`,
          ),
          '    },',
        ]),
    ...renderDependencies({ unconditional: dependencies, conditional: conditionalDependencies }),
    ...(namedDependencies.length === 0
      ? []
      : [
          '    named_deps = {',
          ...namedDependencies.map(
            (dependency) =>
              `        ${starlarkString(dependency.name)}: ${starlarkString(dependency.label)},`,
          ),
          '    },',
        ]),
    ...commonRuleLines,
    ...envLines({
      buildScriptOutputs: buildScript !== undefined,
      crateName: crate,
      ...(rule === 'rust_binary' ? { binName: name } : {}),
    }),
    ...renderRustcFlags([
      // The build script's `cargo:rustc-*` directives (cfgs, link flags) reach every target.
      ...(buildScript === undefined
        ? []
        : [`[${starlarkString(`@$(location :${buildScriptRun}[rustc_flags])`)}]`]),
      // Node-API symbols resolve from the loading node/bun process. Mach-O ld rejects undefined
      // dylib symbols unless told to defer them, as napi-build's setup() does for Cargo.
      // Wasm transitions retain the host OS constraint, but never use Mach-O link flags.
      ...(rule === 'rust_library' && napi !== undefined
        ? [
            `select({${starlarkString(`${buck2LoadLabelPrefix}/rust:wasm32_config`)}: [], "DEFAULT": select({"prelude//os/constraints:macos": ["-Clink-arg=-Wl,-undefined,dynamic_lookup"], "DEFAULT": []})})`,
          ]
        : []),
    ]),
    ...(visibility === undefined
      ? []
      : renderStringList({ name: 'visibility', values: visibility })),
    ')',
    '',
  ]

  const rules: string[] = []
  if (buildScript !== undefined) {
    const buildScriptBuild = `${packageName}-build-script-build`
    const buildScriptLauncher = `${packageName}-build-script`
    const packageFiles = sorted([
      ...new Set([
        'Cargo.toml',
        buildScript.path,
        ...(foreignMember === undefined ? sources : librarySources),
      ]),
    ])
    const duplicateInputs = buildScript.inputs
      .filter(
        (input) =>
          input.label === undefined &&
          packageFiles.includes(input.path.slice(packagePath.length + 1)) === true,
      )
      .map((input) => input.path)
    if (duplicateInputs.length > 0) {
      throw new Error(
        `buildScriptInputs repeat files the build script already sees (Cargo.toml, the build script, Rust sources) in ${member.manifestPath}: ${duplicateInputs.join(', ')}`,
      )
    }
    const manifestEntries: readonly (readonly [string, string])[] = [
      ...packageFiles.map(
        (file) => [`${packagePath}/${file}`, sourceLabel({ file, foreignMember })] as const,
      ),
      ...buildScript.inputs.map(
        (input) => [input.path, input.label ?? input.path.slice(packagePath.length + 1)] as const,
      ),
    ].toSorted(([left], [right]) => compareStrings({ left, right }))
    rules.push(
      'native.rust_binary(',
      `    name = ${starlarkString(buildScriptBuild)},`,
      '    crate = "build_script_build",',
      `    crate_root = ${starlarkString(buildScript.path)},`,
      ...renderSources({ name: 'srcs', values: [buildScript.path], foreignMember }),
      ...renderStringList({
        name: 'deps',
        values: sorted(buildDependencies.map((dependency) => dependency.label)),
      }),
      `    edition = ${starlarkString(edition)},`,
      ...featureLines,
      ...envLines({ buildScriptOutputs: false, crateName: 'build_script_build' }),
      ')',
      '',
      'cargo_build_script(',
      `    name = ${starlarkString(buildScriptLauncher)},`,
      `    build_script = ${starlarkString(`:${buildScriptBuild}`)},`,
      `    package_path = ${starlarkString(packagePath)},`,
      '    srcs = {',
      ...manifestEntries.map(
        ([key, value]) => `        ${starlarkString(key)}: ${starlarkString(value)},`,
      ),
      '    },',
      ')',
      '',
      'buildscript_run(',
      `    name = ${starlarkString(buildScriptRun)},`,
      `    package_name = ${starlarkString(packageName)},`,
      // The launcher runs the build script from the repository-relative tree, so
      // `$CARGO_MANIFEST_DIR/../<pkg>/<file>` reaches the declared inputs.
      `    buildscript_rule = ${starlarkString(`:${buildScriptLauncher}`)},`,
      `    manifest_dir = ${starlarkString(`:${buildScriptLauncher}`)},`,
      // Prelude supplies the staged CARGO_MANIFEST_DIR and toolchain variables.
      // Buck compiles with -Copt-level=0 and no debuginfo, Cargo's `dev` shape without -g.
      '    env = {',
      ...Object.entries({
        ...compileEnv,
        CARGO_CRATE_NAME: 'build_script_build',
        DEBUG: 'false',
        NUM_JOBS: '1',
        PROFILE: 'debug',
      }).map(([name, value]) => `        ${starlarkString(name)}: ${starlarkString(value)},`),
      '    },',
      ...featureLines,
      `    version = ${starlarkString(version)},`,
      ')',
      '',
    )
  }
  if (library !== undefined) {
    rules.push(
      ...renderRule({
        rule: 'rust_library',
        name: foreignMember === undefined ? 'lib' : foreignTargetName(foreignMember),
        crate: library.name,
        crateRoot: library.path,
        ...(library.procMacro === undefined ? {} : { procMacro: library.procMacro }),
        ruleSources: librarySources,
        dependencies: normalLabels,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  for (const binary of foreignMember === undefined ? binaries : []) {
    const binaryDependencies = sorted([...normalLabels, ...(library === undefined ? [] : [':lib'])])
    rules.push(
      ...renderRule({
        rule: 'rust_binary',
        name: binary.name,
        crate: crateIdentifier(binary.name),
        crateRoot: binary.crateRoot,
        ruleSources: sorted([binary.crateRoot, ...srcSources]),
        dependencies: binaryDependencies,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  if (wasmBindgen !== undefined) {
    rules.push(
      'rust_wasm_bindgen_library(',
      `    name = ${starlarkString(wasmBindgen.name)},`,
      '    crate = ":lib",',
      ...(wasmBindgen.visibility === undefined
        ? []
        : renderStringList({ name: 'visibility', values: wasmBindgen.visibility })),
      ...(wasmBindgen.outName === undefined
        ? []
        : [`    out_name = ${starlarkString(wasmBindgen.outName)},`]),
      ...(wasmBindgen.profile === undefined
        ? []
        : [
            `    profile = {${(
              [
                ['opt_level', wasmBindgen.profile.optLevel],
                ['lto', wasmBindgen.profile.lto],
                ['strip', wasmBindgen.profile.strip],
              ] as const
            )
              .flatMap(([key, value]) =>
                value === undefined ? [] : [`${starlarkString(key)}: ${starlarkString(value)}`],
              )
              .join(', ')}},`,
          ]),
      ')',
      '',
    )
  }
  if (wasmGuest !== undefined) {
    rules.push(
      'rust_wasm_guest(',
      `    name = ${starlarkString(wasmGuest.name)},`,
      '    crate = ":lib",',
      `    product_name = ${starlarkString(wasmGuest.productName)},`,
      `    entrypoint = ${starlarkString(wasmGuest.entrypoint)},`,
      `    harness = ${starlarkString(wasmGuest.harness)},`,
      `    recipe = ${starlarkString(wasmGuest.recipe)},`,
      `    toolchain = ${starlarkString(wasmGuest.toolchain)},`,
      ')',
      '',
    )
  }
  if (napi !== undefined) {
    rules.push(
      'rust_napi_library(',
      `    name = ${starlarkString(napi.name)},`,
      '    crate = ":lib",',
      ...(napi.visibility === undefined
        ? []
        : renderStringList({ name: 'visibility', values: napi.visibility })),
      ')',
      '',
    )
  }
  for (const interop of [wasmBindgen, napi]) {
    if (interop?.smoke === undefined) continue
    for (const runtime of interop.smoke.runtimes) {
      rules.push(
        'rust_interop_smoke(',
        `    name = ${starlarkString(`${interop.name}-smoke-${runtime}`)},`,
        `    product = ${starlarkString(`:${interop.name}`)},`,
        `    runtime = ${starlarkString(runtime)},`,
        `    script = ${starlarkString(interop.smoke.script)},`,
        ')',
        '',
      )
    }
  }
  // A product package in another cell than the rules must name the rules
  // cell: a label attribute resolves in the calling package's cell.
  const rulesCell = buck2LoadLabelPrefix.match(/^@([A-Za-z0-9][A-Za-z0-9._-]*)\/\//)?.[1]
  const hostPlatform =
    rulesCell === undefined
      ? 'host_platform_label()'
      : `host_platform_label(cell = ${starlarkString(rulesCell)})`
  for (const product of products) {
    rules.push(
      `rust_product_executable(`,
      `    name = ${starlarkString(`${product.name}-product-executable`)},`,
      `    binary = ${starlarkString(`:${product.binary}`)},`,
      `    recipe = ${starlarkString(`cargo-workspace:${packageName}@${version}`)},`,
      `    target_platform = ${hostPlatform},`,
      ')',
      '',
      'build_product(',
      `    name = ${starlarkString(`${product.name}-product`)},`,
      `    entrypoint = ${starlarkString(product.entrypoint)},`,
      `    executable = ${starlarkString(`:${product.name}-product-executable`)},`,
      `    product_name = ${starlarkString(product.name)},`,
      `    target_platform = ${hostPlatform},`,
      ')',
      '',
    )
  }
  if (foreignMember !== undefined) {
    return createGenieOutput({ data: semanticData, stringify: () => rules.join('\n') })
  }
  const foreignRules = foreignProjections
    .map((projection) => projection.stringify({ cwd: repo.rootPath, location: packagePath }))
    .join('\n')

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
    ...(wasmBindgen === undefined && napi === undefined && wasmGuest === undefined
      ? []
      : [
          `load(${starlarkString(`${buck2LoadLabelPrefix}/rust:interop.bzl`)}, ${[
            ...(wasmBindgen === undefined ? [] : ['"rust_wasm_bindgen_library"']),
            ...(wasmGuest === undefined ? [] : ['"rust_wasm_guest"']),
            ...(napi === undefined ? [] : ['"rust_napi_library"']),
            ...(wasmBindgen?.smoke === undefined && napi?.smoke === undefined
              ? []
              : ['"rust_interop_smoke"']),
          ].join(', ')})`,
        ]),
    ...(products.length > 0
      ? [
          `load(${starlarkString(`${buck2LoadLabelPrefix}/products:defs.bzl`)}, "build_product")`,
          `load(${starlarkString(`${buck2LoadLabelPrefix}/platforms:defs.bzl`)}, "host_platform_label")`,
          `load(${starlarkString(`${buck2LoadLabelPrefix}/rust:defs.bzl`)}, "rust_product_executable")`,
        ]
      : []),
    ...(buildScript === undefined &&
    hostedForeignPackages.every(
      (foreign) =>
        resolveBuildScript({ member: foreign, packagePath: foreign.packagePath, repo }) ===
        undefined,
    ) === true
      ? []
      : [
          `load(${starlarkString(`${buck2LoadLabelPrefix}/rust:defs.bzl`)}, "buildscript_run", "cargo_build_script")`,
        ]),
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
    // A library may be instantiated by consumers of other Cargo workspaces (foreign-packages.json),
    // which compile these exact files against their own third-party graph.
    ...(library === undefined ? [] : instanceFiles).flatMap((file) => [
      'native.export_file(',
      `    name = ${starlarkString(`cargo-source/${file}`)},`,
      `    src = ${starlarkString(file)},`,
      '    visibility = ["PUBLIC"],',
      ')',
      '',
    ]),
    ...rules,
    ...(foreignRules === '' ? [] : [foreignRules]),
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
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) === true ||
    path.isAbsolute(relative) === true
  ) {
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
    path.posix.isAbsolute(value) === true ||
    value.includes('\\') === true ||
    path.posix.normalize(value) !== value ||
    // oxlint-disable-next-line no-control-regex -- Repository paths must reject ASCII control characters.
    /[\u0000-\u001f\u007f]/.test(value) === true ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ===
      true
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
      readonly branch?: string
      readonly 'default-features'?: boolean
      readonly features?: readonly string[]
      /** A git source; Reindeer resolves it to the third-party graph like a registry crate. */
      readonly git?: string
      readonly rev?: string
      readonly tag?: string
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

type CargoPackageTextField =
  | 'description'
  | 'homepage'
  | 'repository'
  | 'license'
  | 'license-file'
  | 'readme'
  | 'rust-version'

type CargoInherited<TValue> = TValue | { readonly workspace?: boolean }

type CargoPackageFields = {
  readonly authors?: CargoInherited<readonly string[]>
  readonly description?: CargoInherited<string>
  readonly homepage?: CargoInherited<string>
  readonly repository?: CargoInherited<string>
  readonly license?: CargoInherited<string>
  readonly 'license-file'?: CargoInherited<string>
  readonly readme?: CargoInherited<string | false>
  readonly 'rust-version'?: CargoInherited<string>
}

type CargoWorkspacePackageFields = {
  readonly authors?: readonly string[]
  readonly description?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly 'license-file'?: string
  readonly readme?: string | false
  readonly 'rust-version'?: string
}

type CargoManifest = {
  readonly package?: CargoPackageFields & {
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
    readonly package?: CargoWorkspacePackageFields & {
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
  readonly workspaceRoot?: string
  readonly workspace?: NonNullable<CargoWorkspace['workspace']>
}

type ProjectionContext = {
  readonly foreignPackageByPath: ReadonlyMap<string, WorkspaceMember>
  readonly foreignTargetPackage: string
  readonly lockPackageNames: ReadonlySet<string>
  readonly memberByPath: ReadonlyMap<string, WorkspaceMember>
  readonly cargoResolution?: CargoResolution
  readonly cargoResolutionPath?: string
  readonly repo: RepoContext
  readonly thirdPartyPackage: string
  readonly thirdPartyTargets: ReadonlySet<string>
  readonly workspace: NonNullable<CargoWorkspace['workspace']>
  readonly workspaceRoot: string
}

type CargoResolution = {
  readonly dependencies: readonly {
    readonly manifestPath: string
    readonly name: string
    readonly package: string
    readonly version: string
    readonly alias: string
    readonly kind: 'normal' | 'dev' | 'build'
    readonly target?: string
  }[]
}

const foreignTargetName = (member: WorkspaceMember): string =>
  `foreign-${requireValue({ value: member.manifest.package?.name, field: `${member.manifestPath} package.name` })}-lib`

const sourceLabel = ({
  file,
  foreignMember,
}: {
  readonly file: string
  readonly foreignMember?: WorkspaceMember
}): string =>
  foreignMember === undefined ? file : `//${foreignMember.packagePath}:cargo-source/${file}`

const renderSources = ({
  name,
  values,
  foreignMember,
}: {
  readonly name: string
  readonly values: readonly string[]
  readonly foreignMember?: WorkspaceMember
}): readonly string[] =>
  foreignMember === undefined
    ? renderStringList({ name, values })
    : [
        '    mapped_srcs = {',
        ...values.map(
          (file) =>
            `        ${starlarkString(sourceLabel({ file, foreignMember }))}: ${starlarkString(file)},`,
        ),
        '    },',
      ]

const contextForMember = ({
  context,
  member,
}: {
  readonly context: ProjectionContext
  readonly member?: WorkspaceMember
}): ProjectionContext =>
  member?.workspace === undefined
    ? context
    : {
        ...context,
        workspace: member.workspace,
        workspaceRoot: requireValue({
          value: member.workspaceRoot,
          field: `${member.manifestPath} workspace root`,
        }),
      }

const findCargoWorkspaceRoot = ({
  repo,
  packagePath,
  manifest,
}: {
  readonly repo: RepoContext
  readonly packagePath: string
  readonly manifest: CargoManifest
}): string => {
  if (manifest.package?.workspace !== undefined) {
    return path.posix.normalize(path.posix.join(packagePath, manifest.package.workspace))
  }
  let directory = packagePath
  for (;;) {
    const candidate = path.posix.join(directory, 'Cargo.toml')
    if (
      existsSync(repo.resolve(candidate)) === true &&
      (Bun.TOML.parse(repo.readText(candidate)) as CargoWorkspace).workspace !== undefined
    ) {
      return directory
    }
    if (directory === '.') return packagePath
    directory = path.posix.dirname(directory)
  }
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
  readonly optional: boolean
  readonly package?: string
  readonly path?: string
  readonly version?: string
  readonly workspace: boolean
} => {
  if (typeof request === 'string') {
    if (request.length === 0) throw new Error(`Empty Cargo version request at ${field}`)
    return {
      defaultFeatures: true,
      features: [],
      optional: false,
      version: request,
      workspace: false,
    }
  }
  assertKnownKeys({
    value: request,
    allowed: [
      'branch',
      'default-features',
      'features',
      'git',
      'optional',
      'package',
      'path',
      'rev',
      'tag',
      'version',
      'workspace',
    ],
    field,
  })
  if (request.package !== undefined && (request.path !== undefined || request.workspace === true)) {
    throw new Error(
      `Unsupported renamed Cargo path or workspace dependency at ${field}: ${dependencyName} -> ${request.package}`,
    )
  }
  if (request.workspace === true && request.path !== undefined) {
    throw new Error(`Cargo dependency at ${field} cannot combine workspace and path`)
  }
  if (request.git !== undefined && (request.path !== undefined || request.workspace === true)) {
    throw new Error(`Cargo dependency at ${field} cannot combine git with path or workspace`)
  }
  if (
    request.git === undefined &&
    (request.branch !== undefined || request.rev !== undefined || request.tag !== undefined)
  ) {
    throw new Error(`Cargo dependency at ${field} sets branch, rev, or tag without git`)
  }
  if (
    request.workspace !== true &&
    request.path === undefined &&
    request.version === undefined &&
    request.git === undefined
  ) {
    throw new Error(
      `Cargo dependency at ${field} has no version, git, path, or workspace inheritance`,
    )
  }
  return {
    defaultFeatures: request['default-features'] ?? true,
    features: sorted(request.features ?? []),
    optional: request.optional === true,
    ...(request.package === undefined ? {} : { package: request.package }),
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
  /** Compiled only when a unified feature activates it (`optional = true`). */
  readonly optional?: true
  /** Registry package behind a renamed request (`name = { package = "..." }`). */
  readonly package?: string
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
  if (memberRequest.optional === true && /(?:^|\.)dev-dependencies\./.test(field) === true) {
    throw new Error(`Cargo dev-dependencies cannot be optional at ${field}`)
  }
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
    if (normalizedInherited.optional === true) {
      throw new Error(`Cargo [workspace.dependencies] cannot be optional: ${dependencyName}`)
    }
    effectiveRequest = {
      defaultFeatures: normalizedInherited.defaultFeatures && memberRequest.defaultFeatures,
      features: sorted([...normalizedInherited.features, ...memberRequest.features]),
      optional: memberRequest.optional,
      ...(normalizedInherited.package === undefined
        ? {}
        : { package: normalizedInherited.package }),
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

  const packageName = effectiveRequest.package ?? dependencyName
  if (context.lockPackageNames.has(packageName) === false) {
    throw new Error(`Cargo.lock has no package for dependency ${packageName} at ${field}`)
  }
  // Reindeer names a public alias after the rename only when the workspace root package
  // declares that rename; otherwise (and always in virtual workspaces) it carries the package name.
  const dependencyKind =
    field.includes('dev-dependencies.') === true
      ? 'dev'
      : field.includes('build-dependencies.') === true
        ? 'build'
        : 'normal'
  const dependencyTarget =
    field.startsWith('target.') === true
      ? field.slice(
          'target.'.length,
          field.lastIndexOf(
            `.${dependencyKind === 'normal' ? 'dependencies' : `${dependencyKind}-dependencies`}.`,
          ),
        )
      : undefined
  const resolved = context.cargoResolution?.dependencies.find(
    (dependency) =>
      dependency.manifestPath === member.manifestPath &&
      dependency.name === dependencyName &&
      dependency.kind === dependencyKind &&
      dependency.target === dependencyTarget,
  )
  if (context.cargoResolution !== undefined && resolved === undefined) {
    throw new Error(
      `Cargo resolution has no dependency ${dependencyName} at ${member.manifestPath} ${field}`,
    )
  }
  const targetName =
    resolved?.alias ??
    (effectiveRequest.package === undefined ||
    rootPackageDeclaresRename({ context, dependencyName, packageName }) === true
      ? dependencyName
      : packageName)
  return {
    defaultFeatures: effectiveRequest.defaultFeatures,
    features: effectiveRequest.features,
    label: `${context.thirdPartyPackage}:${targetName}`,
    name: dependencyName,
    ...(effectiveRequest.optional === true ? { optional: true as const } : {}),
    ...(effectiveRequest.package === undefined ? {} : { package: effectiveRequest.package }),
    requestSource,
    targetAvailable: context.thirdPartyTargets.has(targetName),
    ...(effectiveRequest.version === undefined ? {} : { version: effectiveRequest.version }),
  }
}

/** Whether the workspace root package renames `packageName` to `dependencyName`. */
const rootPackageDeclaresRename = ({
  context,
  dependencyName,
  packageName,
}: {
  readonly context: ProjectionContext
  readonly dependencyName: string
  readonly packageName: string
}): boolean => {
  const rootManifest = context.memberByPath.get(context.workspaceRoot)?.manifest
  if (rootManifest === undefined) return false
  const tables = [
    rootManifest.dependencies,
    rootManifest['dev-dependencies'],
    rootManifest['build-dependencies'],
    ...Object.values(rootManifest.target ?? {}).flatMap((targetTables) => [
      targetTables.dependencies,
      targetTables['dev-dependencies'],
      targetTables['build-dependencies'],
    ]),
  ]
  return tables.some((table) => {
    const request = table?.[dependencyName]
    if (request === undefined || typeof request === 'string') return false
    if (request.package !== undefined) return request.package === packageName
    const inherited = context.workspace.dependencies?.[dependencyName]
    return (
      request.workspace === true &&
      inherited !== undefined &&
      typeof inherited !== 'string' &&
      inherited.package === packageName
    )
  })
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
    readonly optional: boolean
    readonly version?: string
  }
  readonly requestSource: ResolvedDependency['requestSource']
}): ResolvedDependency => {
  const dependencyMember =
    context.memberByPath.get(dependencyPath) ?? context.foreignPackageByPath.get(dependencyPath)
  if (dependencyMember === undefined) {
    throw new Error(
      `Cargo path dependency at ${field} is neither a workspace member nor a declared foreign package: ${dependencyPath}`,
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
    label:
      context.foreignPackageByPath.has(dependencyPath) === true
        ? `//${context.foreignTargetPackage}:${foreignTargetName(dependencyMember)}`
        : `//${dependencyPath}:lib`,
    name: dependencyName,
    ...(request.optional === true ? { optional: true as const } : {}),
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

type CargoLibraryTarget = {
  readonly name: string
  readonly path: string
  readonly crateTypes?: readonly string[]
  readonly procMacro?: boolean
}
type CargoBinaryTarget = {
  readonly crateRoot: string
  readonly name: string
  /** `required-features`: Cargo builds the binary only when all are enabled. */
  readonly requiredFeatures?: readonly string[]
}

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
  const procMacro = explicitLibrary?.['proc-macro'] ?? false
  const crateTypes = explicitLibrary?.['crate-type']
  if (
    crateTypes !== undefined &&
    (crateTypes.length === 0 ||
      crateTypes.some((type) => ['lib', 'rlib', 'cdylib'].includes(type) === false) === true)
  ) {
    throw new Error(`Unsupported Cargo library crate-type in ${member.manifestPath}`)
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
    library = {
      name: explicitLibrary.name ?? crateIdentifier(packageName),
      path: libraryPath,
      ...(crateTypes === undefined ? {} : { crateTypes }),
      ...(procMacro === true ? { procMacro } : {}),
    }
  } else if (autolib === true && sourceSet.has(defaultLibraryPath) === true) {
    library = { name: crateIdentifier(packageName), path: defaultLibraryPath }
  }

  const inferableBinaries: CargoBinaryTarget[] = [
    ...(sourceSet.has('src/main.rs') === true
      ? [{ crateRoot: 'src/main.rs', name: packageName }]
      : []),
    ...sources.flatMap((source) => {
      const match = source.match(/^src\/bin\/(?:([^/.][^/]*)\.rs|([^/.][^/]*)\/main\.rs)$/)
      if (match === null) return []
      const name = requireValue({ value: match[1] ?? match[2], field: `${source} binary name` })
      return [{ crateRoot: source, name }]
    }),
  ]
  const ambiguityError = (names: readonly string[]) =>
    new Error(
      `Cargo binary target discovery is ambiguous in ${member.manifestPath}: ${sorted(names).join(', ')}`,
    )

  const explicitBinaries = (manifest.bin ?? []).map((binary, index) => {
    const requiredFeatures = sorted(binary['required-features'] ?? [])
    const dependencyFeatures = requiredFeatures.filter((feature) => feature.includes('/'))
    if (dependencyFeatures.length > 0) {
      throw new Error(
        `Cargo binary required-features on dependency features are unsupported at bin[${index}]: ${dependencyFeatures.join(', ')}`,
      )
    }
    const name = requireValue({ value: binary.name, field: `bin[${index}].name` })
    const candidates = inferableBinaries.filter((candidate) => candidate.name === name)
    if (binary.path === undefined && candidates.length > 1) throw ambiguityError([name])
    const crateRoot =
      binary.path ??
      candidates[0]?.crateRoot ??
      requireValue<string>({
        value: undefined,
        field: `bin[${index}].path (no src/bin/${name}.rs, src/bin/${name}/main.rs, or src/main.rs for the package binary)`,
      })
    if (sourceSet.has(crateRoot) === false) {
      throw new Error(`Cargo binary path is not a discovered Rust source: ${crateRoot}`)
    }
    return requiredFeatures.length === 0
      ? { crateRoot, name }
      : { crateRoot, name, requiredFeatures }
  })
  const explicitNames = new Set(explicitBinaries.map((binary) => binary.name))
  const explicitRoots = new Set(explicitBinaries.map((binary) => binary.crateRoot))
  // Cargo drops inferred binaries claimed by an explicit name or path before it checks the
  // survivors for duplicate names.
  const inferredBinaries =
    autobins === true
      ? inferableBinaries
          .filter(
            (binary) =>
              explicitNames.has(binary.name) === false &&
              explicitRoots.has(binary.crateRoot) === false,
          )
          .toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
      : []
  const inferredNames = inferredBinaries.map((binary) => binary.name)
  const ambiguousNames = inferredNames.filter(
    (name, index) => inferredNames.indexOf(name) !== index,
  )
  if (ambiguousNames.length > 0) throw ambiguityError(ambiguousNames)
  const binaries = [...explicitBinaries, ...inferredBinaries]
  if (library === undefined && binaries.length === 0) {
    throw new Error(`Cargo package ${member.packagePath} has no library or binary target`)
  }
  if (new Set(binaries.map((binary) => binary.name)).size !== binaries.length) {
    throw new Error(`Cargo package ${member.packagePath} has duplicate binary names`)
  }
  return library === undefined ? { binaries } : { binaries, library }
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
    case 'cfg(target_arch = "wasm32")':
      return ['//buck2/rust:wasm32_config']
    case 'cfg(not(target_arch = "wasm32"))':
      return ['DEFAULT']
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
  const nativeOnly: string[] = []
  for (const entry of conditional) {
    if (base.includes(entry.dependency.label) === true) continue
    if (entry.selectLabels.includes('DEFAULT') === true) {
      nativeOnly.push(entry.dependency.label)
      continue
    }
    for (const selectLabel of entry.selectLabels) {
      const labels = selected.get(selectLabel) ?? []
      labels.push(entry.dependency.label)
      selected.set(selectLabel, labels)
    }
  }
  const nativeSuffix =
    nativeOnly.length === 0
      ? ''
      : ` + select({"//buck2/rust:wasm32_config": [], "DEFAULT": ${JSON.stringify(sorted(nativeOnly))}})`
  const baseLines = renderStringList({ name: 'deps', values: base })
  if (selected.size === 0) return [...baseLines.slice(0, -1), `    ]${nativeSuffix},`]
  return [
    ...baseLines.slice(0, -1),
    `    ]${nativeSuffix} + select({`,
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

type ResolvedCompileTimeResource = {
  readonly path?: string
  readonly label?: string
  readonly destination: string
  readonly fingerprint?: string
}

const resolveCompileTimeResources = ({
  compileTimeResources,
  packagePath,
  repo,
  sources,
}: {
  readonly compileTimeResources: readonly CargoBuck2CompileTimeResource[] | undefined
  readonly packagePath: string
  readonly repo: RepoContext
  readonly sources: readonly string[]
}): readonly ResolvedCompileTimeResource[] => {
  const destinations = [...sources]
  return (compileTimeResources ?? [])
    .map((resource, index) => {
      const field = `compileTimeResources[${index}]`
      assertKnownKeys({ value: resource, allowed: ['path', 'label', 'destination'], field })
      if (resource.path !== undefined) {
        validateRepoPath({ repo, value: resource.path, field: `${field}.path` })
        if (statSync(repo.resolve(resource.path)).isFile() === false) {
          throw new Error(`${field}.path must be a file: ${resource.path}`)
        }
      }
      const inPackage = resource.path?.startsWith(`${packagePath}/`) === true
      if (resource.label !== undefined) {
        const label =
          /^(?:(?:@?[A-Za-z0-9_.-]+)?\/\/([A-Za-z0-9_./@-]*))?:([A-Za-z0-9_.+=,@~/-]+)$/.exec(
            resource.label,
          )
        if (
          label === null ||
          [label[1], label[2]].some(
            (part) =>
              part !== undefined &&
              part !== '' &&
              part
                .split('/')
                .some((segment) => segment === '' || segment === '.' || segment === '..') === true,
          ) === true
        ) {
          throw new Error(`${field}.label must be a normalized Buck target label`)
        }
      }
      if (
        inPackage === false &&
        (resource.label === undefined || resource.destination === undefined)
      ) {
        throw new Error(
          `${field} external or generated resource needs a label and explicit destination`,
        )
      }
      if (inPackage === true && resource.label !== undefined) {
        throw new Error(`${field} inside ${packagePath} takes no label`)
      }
      const destination =
        resource.destination ??
        requireValue({
          value: resource.path,
          field: `${field}.path`,
        }).slice(packagePath.length + 1)
      if (
        destination === '' ||
        path.posix.isAbsolute(destination) === true ||
        /^[A-Za-z]:/.test(destination) === true ||
        destination.includes('\\') === true ||
        path.posix.normalize(destination) !== destination ||
        // oxlint-disable-next-line no-control-regex -- Resource destinations must reject ASCII control characters.
        /[\u0000-\u001f\u007f]/.test(destination) === true ||
        destination
          .split('/')
          .some((segment) => segment === '' || segment === '.' || segment === '..') === true
      ) {
        throw new Error(
          `${field}.destination must be a normalized crate-relative path: ${destination}`,
        )
      }
      if (
        destinations.some(
          (existing) =>
            existing === destination ||
            existing.startsWith(`${destination}/`) === true ||
            destination.startsWith(`${existing}/`) === true,
        ) === true
      ) {
        throw new Error(
          `${field}.destination collides with a Rust source or resource: ${destination}`,
        )
      }
      destinations.push(destination)
      return Object.assign(
        { destination },
        resource.label === undefined ? {} : { label: resource.label },
        resource.path === undefined
          ? {}
          : {
              path: resource.path,
              fingerprint: `sha256:${createHash('sha256')
                .update(readFileSync(repo.resolve(resource.path)))
                .digest('hex')}`,
            },
      )
    })
    .toSorted((left, right) => compareStrings({ left: left.destination, right: right.destination }))
}

type ResolvedBuildScript = {
  /** Package-relative crate root of the build script. */
  readonly path: string
  /** Declared non-Rust inputs; `label` is absent for files inside the package. */
  readonly inputs: readonly { readonly path: string; readonly label?: string }[]
}

/** The package's build script (`build.rs` or `package.build`) and its declared inputs. */
const resolveBuildScript = ({
  buildScriptInputs,
  member,
  packagePath,
  repo,
}: {
  readonly buildScriptInputs: readonly CargoBuck2BuildScriptInput[] | undefined
  readonly member: WorkspaceMember
  readonly packagePath: string
  readonly repo: RepoContext
}): ResolvedBuildScript | undefined => {
  const build = member.manifest.package?.build
  const scriptPath =
    typeof build === 'string'
      ? normalizeBuildScriptPath({ build, manifestPath: member.manifestPath })
      : build === false || existsSync(repo.resolve(packagePath, 'build.rs')) === false
        ? undefined
        : 'build.rs'
  if (build === true && scriptPath === undefined) {
    throw new Error(`Cargo package.build = true needs build.rs in ${member.manifestPath}`)
  }
  if (scriptPath === undefined) {
    if (buildScriptInputs !== undefined) {
      throw new Error(`buildScriptInputs needs a Cargo build script in ${member.manifestPath}`)
    }
    return undefined
  }
  validateRepoPath({ repo, value: `${packagePath}/${scriptPath}`, field: 'package.build' })
  const inputs = (buildScriptInputs ?? []).map((input, index) => {
    const field = `buildScriptInputs[${index}]`
    validateRepoPath({ repo, value: input.path, field: `${field}.path` })
    const inPackage = input.path.startsWith(`${packagePath}/`)
    if (inPackage === true && input.label !== undefined) {
      throw new Error(`${field} is inside ${packagePath} and takes no label: ${input.path}`)
    }
    if (inPackage === false) {
      if (
        input.label === undefined ||
        /^(?:@?[A-Za-z0-9_.-]+)?\/\/[A-Za-z0-9_./@-]*:[A-Za-z0-9_.+=,@~/-]+$/.test(input.label) ===
          false
      ) {
        throw new Error(
          `${field} outside ${packagePath} needs the Buck label providing it: ${input.path}`,
        )
      }
    }
    return input.label === undefined
      ? { path: input.path }
      : { label: input.label, path: input.path }
  })
  const duplicatePaths = inputs
    .map((input) => input.path)
    .filter((inputPath, index, paths) => paths.indexOf(inputPath) !== index)
  if (duplicatePaths.length > 0) {
    throw new Error(`buildScriptInputs repeat paths: ${sorted(duplicatePaths).join(', ')}`)
  }
  return {
    inputs: inputs.toSorted((left, right) =>
      compareStrings({ left: left.path, right: right.path }),
    ),
    path: scriptPath,
  }
}

const normalizeBuildScriptPath = ({
  build,
  manifestPath,
}: {
  readonly build: string
  readonly manifestPath: string
}): string => {
  const normalized = path.posix.normalize(build)
  if (
    normalized !== build ||
    path.posix.isAbsolute(build) === true ||
    build.split('/').some((segment) => segment === '..' || segment === '.' || segment === '') ===
      true ||
    build.endsWith('.rs') === false
  ) {
    throw new Error(`Cargo package.build must be a package-relative .rs path in ${manifestPath}`)
  }
  return build
}

type ResolvedProduct = {
  readonly binary: string
  readonly entrypoint: string
  readonly name: string
}

/**
 * The products a package emits: `buildProduct` packages its only binary under the package
 * name; `buildProducts` names each product and the Cargo binary it packages.
 */
const resolveProducts = ({
  binaries,
  buildProduct,
  buildProducts,
  manifestPath,
  packageName,
}: {
  readonly binaries: readonly CargoBinaryTarget[]
  readonly buildProduct: boolean
  readonly buildProducts: readonly CargoBuck2ProductOptions[] | undefined
  readonly manifestPath: string
  readonly packageName: string
}): readonly ResolvedProduct[] => {
  if (buildProducts === undefined) {
    if (buildProduct === false) return []
    const binary = binaries.length === 1 ? binaries[0] : undefined
    if (binary === undefined) {
      throw new Error(`BuildProduct projection requires exactly one binary in ${manifestPath}`)
    }
    return [{ binary: binary.name, entrypoint: `bin/${packageName}`, name: packageName }]
  }
  if (buildProduct === true) {
    throw new Error(`buildProduct and buildProducts are mutually exclusive in ${manifestPath}`)
  }
  if (buildProducts.length === 0) {
    throw new Error(`buildProducts must name at least one product in ${manifestPath}`)
  }
  const binaryNames = new Set(binaries.map((binary) => binary.name))
  const products = buildProducts.map((product, index) => {
    const field = `buildProducts[${index}]`
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(product.name) === false) {
      throw new Error(`${field}.name is not a Buck target-safe product name: ${product.name}`)
    }
    const binary = product.binary ?? product.name
    if (binaryNames.has(binary) === false) {
      throw new Error(
        `${field} packages unknown Cargo binary ${binary} in ${manifestPath} (binaries: ${sorted([...binaryNames]).join(', ')})`,
      )
    }
    const entrypoint = product.entrypoint ?? `bin/${product.name}`
    if (
      /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(entrypoint) === false ||
      entrypoint.split('/').some((segment) => segment === '.' || segment === '..') === true
    ) {
      throw new Error(`${field}.entrypoint must be a normalized relative path: ${entrypoint}`)
    }
    return { binary, entrypoint, name: product.name }
  })
  const duplicateNames = products
    .map((product) => product.name)
    .filter((name, index, names) => names.indexOf(name) !== index)
  if (duplicateNames.length > 0) {
    throw new Error(
      `buildProducts names repeat in ${manifestPath}: ${sorted(duplicateNames).join(', ')}`,
    )
  }
  return products
}

const memoize = <TValue>(compute: () => TValue): (() => TValue) => {
  let cached: { readonly value: TValue } | undefined
  return () => {
    cached ??= { value: compute() }
    return cached.value
  }
}

type MemberFeatureState = {
  /** Optional dependencies (by request name) that an enabled feature activates. */
  readonly activeOptional: ReadonlySet<string>
  /** Declared features plus the implicit features of optional dependencies. */
  readonly definedFeatures: ReadonlySet<string>
  /** Unified enabled features, `default` included when declared and requested. */
  readonly features: ReadonlySet<string>
}

type MemberFeatures = {
  readonly member: WorkspaceMember
  readonly declared: Readonly<Record<string, readonly string[]>>
  readonly dependenciesByName: ReadonlyMap<string, readonly ResolvedDependency[]>
  readonly implicit: ReadonlySet<string>
  readonly features: Set<string>
  readonly activeOptional: Set<string>
  /** Weak `dep?/feature` requests waiting for `dep` to activate. */
  readonly pendingWeak: Map<string, string[]>
}

const dependenciesNamed = ({
  state,
  name,
  via,
}: {
  readonly state: MemberFeatures
  readonly name: string
  readonly via: string
}): readonly ResolvedDependency[] => {
  const dependencies = state.dependenciesByName.get(name)
  if (dependencies === undefined) {
    throw new Error(
      `Cargo feature ${via} in ${state.member.manifestPath} names no dependency ${name}`,
    )
  }
  return dependencies
}

/** Cargo validates every declared feature item, enabled or not. */
const validateFeatureItem = ({
  state,
  item,
}: {
  readonly state: MemberFeatures
  readonly item: string
}): void => {
  const slash = item.indexOf('/')
  if (item.startsWith('dep:') === true) {
    const name = item.slice('dep:'.length)
    const dependencies = dependenciesNamed({ state, name, via: item })
    if (dependencies.some((dependency) => dependency.optional === true) === false) {
      throw new Error(
        `Cargo feature ${item} in ${state.member.manifestPath} names a non-optional dependency`,
      )
    }
  } else if (slash !== -1) {
    const rawName = item.slice(0, slash)
    const name = rawName.endsWith('?') === true ? rawName.slice(0, -1) : rawName
    dependenciesNamed({ state, name, via: item })
  } else if (Object.hasOwn(state.declared, item) === false && state.implicit.has(item) === false) {
    throw new Error(`Cargo feature ${item} is not defined in ${state.member.manifestPath}`)
  }
}

/**
 * Cargo feature unification across the workspace, matching `cargo build --workspace`
 * under resolver 2: every member is a root with its default features, and each normal
 * dependency edge (activated optional ones included) adds the features it requests on a
 * member library. Every member has one `:lib`, so it compiles with the union. Features
 * requested of third-party crates are Reindeer's concern and are only validated here.
 */
const resolveWorkspaceFeatures = ({
  context,
}: {
  readonly context: ProjectionContext
}): ReadonlyMap<string, MemberFeatureState> => {
  const members = [...context.memberByPath.values(), ...context.foreignPackageByPath.values()]
  const usesFeatures = members.some(
    (member) =>
      Object.keys(member.manifest.features ?? {}).length > 0 ||
      (member.manifest.bin ?? []).some(
        (binary) => (binary['required-features']?.length ?? 0) > 0,
      ) === true ||
      [
        member.manifest.dependencies,
        ...Object.values(member.manifest.target ?? {}).map((tables) => tables.dependencies),
      ].some((table) =>
        Object.values(table ?? {}).some(
          (request) => typeof request !== 'string' && request.optional === true,
        ),
      ) === true,
  )
  if (usesFeatures === false) return new Map()

  const memberPathsByLabel = new Map(
    members.map((member) => [
      context.foreignPackageByPath.has(member.packagePath) === true
        ? `//${context.foreignTargetPackage}:${foreignTargetName(member)}`
        : `//${member.packagePath}:lib`,
      member.packagePath,
    ]),
  )
  const isMemberLabel = (label: string): boolean => memberPathsByLabel.has(label)
  const states = new Map<string, MemberFeatures>()
  for (const member of members) {
    const conditionalDependencies = resolveConditionalDependencies({
      context: contextForMember({ context, member }),
      member,
      target: member.manifest.target,
      kind: 'dependencies',
    }).map((entry) => entry.dependency)
    // Each member has one `:lib` with one feature list, so a request that only holds on
    // some platforms (resolver 2) would leak onto every platform.
    const platformSpecificMemberRequests = conditionalDependencies.filter(
      (dependency) =>
        isMemberLabel(dependency.label) === true &&
        (dependency.optional === true || dependency.features.length > 0),
    )
    if (platformSpecificMemberRequests.length > 0) {
      throw new Error(
        `Target-specific Cargo dependencies on workspace members cannot request features or be optional in ${member.manifestPath}: ${sorted(platformSpecificMemberRequests.map((dependency) => dependency.name)).join(', ')}`,
      )
    }
    const dependencies = [
      ...resolveDependencyTable({
        context: contextForMember({ context, member }),
        member,
        dependencies: member.manifest.dependencies,
        field: 'dependencies',
      }),
      ...conditionalDependencies,
    ]
    const dependenciesByName = new Map<string, ResolvedDependency[]>()
    for (const dependency of dependencies) {
      dependenciesByName.set(dependency.name, [
        ...(dependenciesByName.get(dependency.name) ?? []),
        dependency,
      ])
    }
    const declared = member.manifest.features ?? {}
    const explicitDependencyReferences = new Set(
      Object.values(declared)
        .flat()
        .filter((item) => item.startsWith('dep:'))
        .map((item) => item.slice('dep:'.length)),
    )
    // Cargo defines a feature per optional dependency unless a `dep:` item names it.
    const implicit = new Set(
      dependencies
        .filter(
          (dependency) =>
            dependency.optional === true &&
            explicitDependencyReferences.has(dependency.name) === false,
        )
        .map((dependency) => dependency.name),
    )
    const collisions = [...implicit].filter((name) => Object.hasOwn(declared, name))
    if (collisions.length > 0) {
      throw new Error(
        `Cargo features collide with implicit optional-dependency features in ${member.manifestPath}: ${sorted(collisions).join(', ')}`,
      )
    }
    states.set(member.packagePath, {
      member,
      declared,
      dependenciesByName,
      implicit,
      features: new Set(),
      activeOptional: new Set(),
      pendingWeak: new Map(),
    })
  }

  const memberState = (dependency: ResolvedDependency): MemberFeatures | undefined => {
    const packagePath = memberPathsByLabel.get(dependency.label)
    return packagePath === undefined ? undefined : states.get(packagePath)
  }
  const requestFeature = ({
    dependency,
    feature,
  }: {
    readonly dependency: ResolvedDependency
    readonly feature: string
  }) => {
    const target = memberState(dependency)
    if (target !== undefined) enableFeature({ state: target, feature })
  }
  const activatedPackages = new Set(context.memberByPath.keys())
  const requestDependency = (dependency: ResolvedDependency) => {
    const target = memberState(dependency)
    if (target === undefined) return
    if (activatedPackages.has(target.member.packagePath) === false) {
      activatedPackages.add(target.member.packagePath)
      for (const dependencies of target.dependenciesByName.values()) {
        for (const nested of dependencies) {
          if (nested.optional !== true) requestDependency(nested)
        }
      }
    }
    if (dependency.defaultFeatures === true && Object.hasOwn(target.declared, 'default') === true) {
      enableFeature({ state: target, feature: 'default' })
    }
    for (const feature of dependency.features) enableFeature({ state: target, feature })
  }
  const activate = ({ state, name }: { readonly state: MemberFeatures; readonly name: string }) => {
    if (state.activeOptional.has(name) === true) return
    state.activeOptional.add(name)
    if (state.implicit.has(name) === true) enableFeature({ state, feature: name })
    for (const dependency of dependenciesNamed({ state, name, via: `dep:${name}` })) {
      requestDependency(dependency)
      for (const feature of state.pendingWeak.get(name) ?? []) {
        requestFeature({ dependency, feature })
      }
    }
    state.pendingWeak.delete(name)
  }
  const applyItem = ({
    state,
    item,
  }: {
    readonly state: MemberFeatures
    readonly item: string
  }) => {
    if (item.startsWith('dep:') === true) {
      activate({ state, name: item.slice('dep:'.length) })
      return
    }
    const slash = item.indexOf('/')
    if (slash === -1) {
      enableFeature({ state, feature: item })
      return
    }
    const weak = item.slice(0, slash).endsWith('?')
    const name = item.slice(0, weak === true ? slash - 1 : slash)
    const feature = item.slice(slash + 1)
    const dependencies = dependenciesNamed({ state, name, via: item })
    const optional = dependencies.some((dependency) => dependency.optional === true)
    if (weak === false && optional === true) activate({ state, name })
    if (optional === false || state.activeOptional.has(name) === true) {
      for (const dependency of dependencies) requestFeature({ dependency, feature })
    } else {
      state.pendingWeak.set(name, [...(state.pendingWeak.get(name) ?? []), feature])
    }
  }
  const enableFeature = ({
    state,
    feature,
  }: {
    readonly state: MemberFeatures
    readonly feature: string
  }): void => {
    if (state.features.has(feature) === true) return
    const items =
      Object.hasOwn(state.declared, feature) === true
        ? state.declared[feature]
        : state.implicit.has(feature) === true
          ? [`dep:${feature}`]
          : undefined
    if (items === undefined) {
      throw new Error(`Cargo feature ${feature} is not defined in ${state.member.manifestPath}`)
    }
    state.features.add(feature)
    for (const item of items) applyItem({ state, item })
  }

  for (const state of states.values()) {
    for (const items of Object.values(state.declared)) {
      for (const item of items) validateFeatureItem({ state, item })
    }
  }
  for (const state of states.values()) {
    if (context.memberByPath.has(state.member.packagePath) === false) continue
    if (Object.hasOwn(state.declared, 'default') === true) {
      enableFeature({ state, feature: 'default' })
    }
    for (const dependencies of state.dependenciesByName.values()) {
      for (const dependency of dependencies) {
        if (dependency.optional !== true) requestDependency(dependency)
      }
    }
  }
  return new Map(
    [...states].map(([packagePath, state]) => [
      packagePath,
      {
        activeOptional: state.activeOptional,
        definedFeatures: new Set([...Object.keys(state.declared), ...state.implicit]),
        features: state.features,
      },
    ]),
  )
}

const effectUtilsWorkspaceMemberManifestPaths = [
  'packages/@overeng/otel-scrape/Cargo.toml',
  'packages/@overeng/otelite/Cargo.toml',
  'rust/buck2-tools/archive-tool/Cargo.toml',
  'rust/buck2-tools/core/Cargo.toml',
  'rust/buck2-tools/events/Cargo.toml',
  'rust/buck2-tools/product/Cargo.toml',
  'rust/effect-rust/Cargo.toml',
  'rust/effect-rust-macros/Cargo.toml',
  'rust/effect-rust-fixtures/hash-interop/Cargo.toml',
  'rust/effect-rust-fixtures/math-interop/Cargo.toml',
  'rust/effect-rust-fixtures/hash-core/Cargo.toml',
  'rust/effect-rust-fixtures/math-core/Cargo.toml',
  'rust/effect-rust-fixtures/wasm-adapter/Cargo.toml',
  'rust/effect-rust-fixtures/napi-adapter/Cargo.toml',
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
