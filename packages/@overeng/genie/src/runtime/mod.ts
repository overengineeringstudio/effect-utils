export type { GenieContext, GenieOutput, Strict } from './core.ts'

export * from './github-action/mod.ts'
export * from './github-ruleset/mod.ts'
export * from './github-workflow/mod.ts'
export * from './megarepo-config/mod.ts'
export * from './oxfmt-config/mod.ts'
export * from './oxlint-config/mod.ts'
export {
  CatalogConflictError,
  OverrideConflictError,
  defineCatalog,
  defineOverrides,
  definePatchedDependencies,
  packageJson,
  declarationPathMappingsForPackage,
  type AggregatePackageJsonData,
  type Catalog,
  type CatalogInput,
  type ExtendedOverridesInput,
  type OverridesInput,
  type PackageJsonData,
  type PatchesRegistry,
  type ScriptValue,
  type WorkspaceIdentity,
  type WorkspaceMeta,
  type WorkspaceMetadata,
  type WorkspacePackage,
  type WorkspacePackageLike,
} from './package-json/mod.ts'
export {
  pnpmWorkspaceYaml,
  type PnpmSettings,
  type PnpmWorkspaceData,
} from './pnpm-workspace/mod.ts'
export * from './tsconfig-json/mod.ts'
export * from './validation/mod.ts'
export { validateCatalogPeerDeps, parsePeerDepsFromLockfile } from './catalog-peer-deps/mod.ts'
export {
  validateCrossInstallRootVersions,
  detectVersionDivergence,
  parseResolvedVersionsFromLockfile,
} from './cross-install-root/mod.ts'
export { satisfiesRange, parseVersion } from './semver/mod.ts'
