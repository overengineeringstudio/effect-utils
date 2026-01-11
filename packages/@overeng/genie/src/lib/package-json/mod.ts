/**
 * Type-safe package.json generator
 * Reference: https://github.com/sindresorhus/type-fest/blob/main/source/package-json.d.ts
 */

export {
  CatalogBrand,
  defineCatalog,
  CatalogConflictError,
  type Catalog,
  type CatalogInput,
  type ExtendedCatalogInput,
} from './catalog.ts'

import {
  type ValidationConfig,
  type ValidationIssue,
  type DepsToValidate,
  assertNoValidationErrors,
  formatValidationIssues,
  matchesAnyPattern,
} from './validation.ts'

export type {
  ValidationConfig,
  ValidationIssue,
  ValidationFn,
  VersionConstraint,
  DepsToValidate,
} from './validation.ts'
export {
  assertNoValidationErrors,
  formatValidationIssues,
  matchesPattern,
  matchesAnyPattern,
  validateVersionConstraints,
} from './validation.ts'

/**
 * Field ordering for package.json (matches syncpack sortFirst convention).
 * Fields are sorted in this order, with unlisted fields appearing after.
 */
const FIELD_ORDER = [
  '$genie',
  'name',
  'version',
  'type',
  'sideEffects',
  'private',
  'description',
  'keywords',
  'homepage',
  'bugs',
  'license',
  'author',
  'contributors',
  'repository',
  'exports',
  'imports',
  'main',
  'module',
  'types',
  'typings',
  'bin',
  'files',
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundledDependencies',
  'engines',
  'os',
  'cpu',
  'publishConfig',
  'workspaces',
  'pnpm',
  'resolutions',
] as const

/**
 * Export condition ordering for package.json exports (matches syncpack sortExports convention).
 * Conditions are sorted in this order within each export entry.
 */
const EXPORT_CONDITION_ORDER = [
  'types',
  'workerd',
  'browser',
  'worker',
  'node-addons',
  'node',
  'bun',
  'react-native',
  'import',
  'require',
  'development',
  'production',
  'default',
] as const

type Person =
  | string
  | {
      name: string
      email?: string
      url?: string
    }

type Bugs =
  | string
  | {
      url?: string
      email?: string
    }

type Repository =
  | string
  | {
      type: string
      url: string
      directory?: string
    }

type ExportsEntry =
  | string
  | Record<string, string>
  | {
      import?: string
      require?: string
      node?: string
      default?: string
      types?: string
      browser?: string
    }

type Funding =
  | string
  | {
      type?: string
      url?: string
    }

/** Arguments for generating a package.json file */
export type PackageJSONArgs = {
  /** Package name */
  name?: string
  /** Package version (semver) */
  version?: string
  /** Short package description */
  description?: string
  /** Keywords for npm search */
  keywords?: string[]
  /** Homepage URL */
  homepage?: string
  /** Bug tracker URL or configuration */
  bugs?: Bugs
  /** License identifier (SPDX) */
  license?: string
  /** Package author */
  author?: Person
  /** Package contributors */
  contributors?: Person[]
  /** Repository information */
  repository?: Repository
  /** Main entry point (CJS) */
  main?: string
  /** Module entry point (ESM) */
  module?: string
  /** TypeScript types definition file */
  types?: string
  /** TypeScript types definition file (legacy alias) */
  typings?: string
  /** Files to include when publishing */
  files?: string[]
  /** Package entry points (modern ESM exports) */
  exports?: Record<string, ExportsEntry>
  /** Node.js subpath imports (private path aliases, e.g. `#utils/*`) */
  imports?: Record<string, string>
  /** Package type: "module" for ESM, "commonjs" for CJS */
  type?: 'module' | 'commonjs'
  /** Binary executables */
  bin?: string | Record<string, string>
  /** Man pages */
  man?: string | string[]
  /** Directory structure */
  directories?: {
    lib?: string
    bin?: string
    man?: string
    doc?: string
    example?: string
    test?: string
  }
  /** npm scripts */
  scripts?: Record<string, string>
  /** Package configuration values */
  config?: Record<string, unknown>
  /** Production dependencies */
  dependencies?: Record<string, string>
  /** Development dependencies */
  devDependencies?: Record<string, string>
  /** Peer dependencies */
  peerDependencies?: Record<string, string>
  /** Peer dependency metadata */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  /** Optional dependencies */
  optionalDependencies?: Record<string, string>
  /** Bundled dependencies */
  bundledDependencies?: string[]
  /** Engine requirements */
  engines?: {
    node?: string
    npm?: string
    pnpm?: string
    yarn?: string
  }
  /** Supported operating systems */
  os?: string[]
  /** Supported CPU architectures */
  cpu?: string[]
  /** Mark as private (prevents publishing) */
  private?: boolean
  /** Publishing configuration */
  publishConfig?: {
    access?: 'public' | 'restricted'
    registry?: string
    tag?: string
    /** Package entry points for published package (typically pointing to dist/) */
    exports?: Record<string, ExportsEntry>
    [key: string]: unknown
  }
  /** Workspace configuration */
  workspaces?: string[] | { packages?: string[] }
  /** pnpm-specific configuration */
  pnpm?: {
    overrides?: Record<string, string>
    /** Patched dependencies with paths to patch files */
    patchedDependencies?: Record<string, string>
    /** Packages that should only be built (not hoisted) */
    onlyBuiltDependencies?: string[]
    packageExtensions?: Record<
      string,
      {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
    >
    peerDependencyRules?: {
      allowedVersions?: Record<string, string>
      ignoreMissing?: string[]
    }
  }
  /** npm/pnpm hooks */
  hooks?: Record<string, string>
  /** Tree-shaking side effects configuration */
  sideEffects?: boolean | string[]
  /** Browser field for bundlers */
  browser?: string | Record<string, string | false>
  /** Funding information */
  funding?: Funding | Funding[]
  /** Yarn resolutions */
  resolutions?: Record<string, string>
  /** pnpm: prefer unplugged */
  preferUnplugged?: boolean
  /** Package manager for corepack */
  packageManager?: string
  /** pnpm catalog references */
  catalog?: Record<string, string>
  /** pnpm patched dependencies */
  patchedDependencies?: Record<string, string>
}

/** Options for customizing package.json generation */
export type PackageJSONOptions = {
  /** Custom stringify function */
  stringify?: (args: PackageJSONArgs) => string
}

/**
 * Creates a package.json configuration string.
 *
 * Generated files include a `$genie` field which is enriched by cli.ts with source file
 * information. The field appears at the end after oxfmt sorting (known fields first).
 *
 * For monorepos with a shared catalog, prefer using {@link createPackageJson} which provides
 * compile-time validation of dependency names against the catalog.
 *
 * @example
 * ```ts
 * export default packageJSON({
 *   name: "my-package",
 *   version: "1.0.0",
 *   type: "module",
 *   exports: { ".": "./src/mod.ts" }
 * })
 * ```
 */
// oxlint-disable-next-line overeng/named-args -- DSL-style API
export const packageJSON = (args: PackageJSONArgs, options?: PackageJSONOptions): string => {
  if (args.private !== true) {
    if (args.name === undefined) {
      console.warn('Warning: Package is not private but missing a name')
    }
    if (args.version === undefined) {
      console.warn('Warning: Package is not private but missing a version')
    }
  }

  // Add marker field - cli.ts enriches this with source file info
  const withMarker = {
    $genie: true,
    ...args,
  }

  return options?.stringify?.(withMarker) ?? JSON.stringify(withMarker, null, 2)
}

// -----------------------------------------------------------------------------
// packageJsonWithContext - dependency inference and sorting
// -----------------------------------------------------------------------------

/** Context for dependency inference */
export type PackageJsonContext = {
  /** Catalog of package versions (package name → version string) */
  catalog: Record<string, string>
  /** List of workspace package names or glob patterns */
  workspacePackages: readonly string[]
}

/**
 * Peer dependency range specifier.
 * - `'^'` or `'~'`: Use catalog version with this semver range prefix
 * - Explicit version string: Use as-is
 */
type PeerDepRange = '^' | '~' | string

/** Configuration for packageJsonWithContext with inference support */
export type PackageJsonWithContextConfig = Omit<
  PackageJSONArgs,
  'dependencies' | 'devDependencies' | 'peerDependencies'
> & {
  /** Dependencies - package names resolved via catalog/workspace */
  dependencies?: string[]
  /** Dev dependencies - package names resolved via catalog/workspace */
  devDependencies?: string[]
  /** Peer dependencies with range specifiers */
  peerDependencies?: Record<string, PeerDepRange>
}

/** Error thrown when a dependency cannot be resolved */
class DependencyResolutionError extends Error {
  // oxlint-disable-next-line overeng/named-args -- simple error class
  constructor(
    public readonly packageName: string,
    public readonly dependencyName: string,
    public readonly reason: string,
  ) {
    super(`[${packageName}] Cannot resolve dependency "${dependencyName}": ${reason}`)
    this.name = 'DependencyResolutionError'
  }
}

/**
 * Check if a package name matches any workspace package pattern.
 * Supports exact matches and glob patterns with `*` and `**`.
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const isWorkspacePackage = (name: string, workspacePackages: readonly string[]): boolean => {
  for (const pattern of workspacePackages) {
    if (pattern === name) return true
    // Simple glob matching for patterns like '@scope/*' or '@scope/**'
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' +
          pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
            .replace(/\*\*/g, '.*') // ** matches anything
            .replace(/\*/g, '[^/]*') + // * matches anything except /
          '$',
      )
      if (regex.test(name)) return true
    }
  }
  return false
}

/**
 * Resolve a dependency to its version specifier.
 * - Workspace packages → `workspace:*`
 * - Catalog packages → `catalog:`
 * - Unknown → throws error
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const resolveDependency = (
  depName: string,
  packageName: string,
  context: PackageJsonContext,
): string => {
  // Check workspace first
  if (isWorkspacePackage(depName, context.workspacePackages)) {
    return 'workspace:*'
  }
  // Check catalog
  if (depName in context.catalog) {
    return 'catalog:'
  }
  // Unknown dependency
  throw new DependencyResolutionError(
    packageName,
    depName,
    `not found in catalog or workspace packages. Add it to the catalog or check the spelling.`,
  )
}

/**
 * Resolve dependencies from array format.
 * Each dependency is resolved to `catalog:` or `workspace:*`.
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const resolveDependencies = (
  deps: string[] | undefined,
  packageName: string,
  context: PackageJsonContext,
): Record<string, string> | undefined => {
  if (deps === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const dep of deps) {
    resolved[dep] = resolveDependency(dep, packageName, context)
  }
  // Sort alphabetically
  return Object.fromEntries(Object.entries(resolved).toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Resolve peer dependencies with range expansion.
 * - `'^'` or `'~'` → prepend to catalog version
 * - Explicit version → pass through
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const resolvePeerDependencies = (
  peerDeps: Record<string, PeerDepRange> | undefined,
  packageName: string,
  context: PackageJsonContext,
): Record<string, string> | undefined => {
  if (peerDeps === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [dep, range] of Object.entries(peerDeps)) {
    if (range === '^' || range === '~') {
      // Range specifier - expand from catalog
      const catalogVersion = context.catalog[dep]
      if (catalogVersion === undefined) {
        throw new DependencyResolutionError(
          packageName,
          dep,
          `peer dependency with range "${range}" requires package to be in catalog`,
        )
      }
      resolved[dep] = `${range}${catalogVersion}`
    } else {
      // Explicit version - pass through
      resolved[dep] = range
    }
  }
  // Sort alphabetically
  return Object.fromEntries(Object.entries(resolved).toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Sort object keys according to a defined order.
 * Keys in the order array appear first (in that order), then remaining keys alphabetically.
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const sortObjectKeys = <T extends Record<string, unknown>>(obj: T, order: readonly string[]): T => {
  const orderSet = new Set(order)
  const orderedKeys = order.filter((key) => key in obj)
  const remainingKeys = Object.keys(obj)
    .filter((key) => !orderSet.has(key))
    .toSorted()
  const sortedKeys = [...orderedKeys, ...remainingKeys]
  return Object.fromEntries(sortedKeys.map((key) => [key, obj[key]])) as T
}

/**
 * Sort export conditions within an exports entry.
 */
const sortExportConditions = (entry: ExportsEntry): ExportsEntry => {
  if (typeof entry === 'string') return entry
  return sortObjectKeys(entry, EXPORT_CONDITION_ORDER)
}

/**
 * Sort exports object - sort conditions within each entry.
 */
const sortExports = (
  exports: Record<string, ExportsEntry> | undefined,
): Record<string, ExportsEntry> | undefined => {
  if (exports === undefined) return undefined

  const sorted: Record<string, ExportsEntry> = {}
  // Sort export paths: '.' first, then alphabetically
  const paths = Object.keys(exports).toSorted((a, b) => {
    if (a === '.') return -1
    if (b === '.') return 1
    return a.localeCompare(b)
  })

  for (const path of paths) {
    sorted[path] = sortExportConditions(exports[path]!)
  }
  return sorted
}

/**
 * Creates a package.json configuration with dependency inference and field sorting.
 *
 * Features:
 * - Dependencies as `string[]` are resolved to `catalog:` or `workspace:*`
 * - Peer dependencies with `'^'` or `'~'` expand to catalog version with range
 * - Fields sorted according to conventional order (name, version, type, exports, ...)
 * - Export conditions sorted (types first, default last)
 * - Throws on unknown dependencies (catches typos)
 *
 * @example
 * ```ts
 * import { packageJsonWithContext } from '@overeng/genie'
 * import { catalog, workspacePackages } from '../../../genie/repo.ts'
 *
 * export default packageJsonWithContext({
 *   name: '@myorg/common',
 *   dependencies: ['effect', '@effect/platform'],
 *   peerDependencies: { react: '^' },
 *   exports: { '.': './src/mod.ts' },
 * }, { catalog, workspacePackages })
 * ```
 */
// oxlint-disable-next-line overeng/named-args -- DSL-style API
export const packageJsonWithContext = (
  config: PackageJsonWithContextConfig,
  context: PackageJsonContext,
): string => {
  const packageName = config.name ?? '<unknown>'

  // Resolve dependencies
  const dependencies = resolveDependencies(config.dependencies, packageName, context)
  const devDependencies = resolveDependencies(config.devDependencies, packageName, context)
  const peerDependencies = resolvePeerDependencies(config.peerDependencies, packageName, context)

  // Sort exports
  const exports = sortExports(config.exports)

  // Build the package.json object, filtering out undefined values
  // Omit dep fields from config spread since we've resolved them
  const {
    dependencies: _deps,
    devDependencies: _devDeps,
    peerDependencies: _peerDeps,
    exports: _exports,
    ...restConfig
  } = config
  const packageJson: PackageJSONArgs = {
    ...restConfig,
    ...(dependencies !== undefined && { dependencies }),
    ...(devDependencies !== undefined && { devDependencies }),
    ...(peerDependencies !== undefined && { peerDependencies }),
    ...(exports !== undefined && { exports }),
  }

  // Validate required fields for non-private packages
  if (packageJson.private !== true) {
    if (packageJson.name === undefined) {
      console.warn('Warning: Package is not private but missing a name')
    }
    if (packageJson.version === undefined) {
      console.warn('Warning: Package is not private but missing a version')
    }
  }

  // Add marker and sort fields
  const withMarker = sortObjectKeys(
    {
      $genie: true,
      ...packageJson,
    },
    FIELD_ORDER,
  )

  return JSON.stringify(withMarker, null, 2)
}

// -----------------------------------------------------------------------------
// createPackageJson - type-safe curried builder with package manager support
// -----------------------------------------------------------------------------

/**
 * Convert a glob pattern like `@scope/*` to a template literal type `@scope/${string}`.
 * Supports `*` (single segment) and `**` (any segments).
 */
type PatternToTemplate<P extends string> = P extends `${infer Prefix}/**`
  ? `${Prefix}/${string}`
  : P extends `${infer Prefix}/*`
    ? `${Prefix}/${string}`
    : P

/**
 * Union of all valid dependency names from workspace patterns.
 * Converts patterns like `@scope/*` to template literal types.
 */
type WorkspaceDep<TWorkspace extends readonly string[]> = PatternToTemplate<TWorkspace[number]>

/**
 * Valid dependency name: either a catalog key or a workspace pattern match.
 */
type ValidDep<TCatalog extends Record<string, string>, TWorkspace extends readonly string[]> =
  | (keyof TCatalog & string)
  | WorkspaceDep<TWorkspace>

/**
 * Peer dependency range specifier for type-safe builder.
 * - `'^'` or `'~'`: Expand catalog version with range prefix
 * - Explicit string: Pass through as-is (e.g. `'>=0.32.0'`)
 */
type PeerDepRangeStrict = '^' | '~'

// -----------------------------------------------------------------------------
// Package manager types
// -----------------------------------------------------------------------------

/** PNPM-specific namespace configuration (root-only) */
type PnpmNamespaceConfig = {
  overrides?: Record<string, string>
  patchedDependencies?: Record<string, string>
  onlyBuiltDependencies?: string[]
  neverBuiltDependencies?: string[]
  packageExtensions?: Record<
    string,
    {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
  >
  peerDependencyRules?: {
    allowedVersions?: Record<string, string>
    ignoreMissing?: string[]
    allowAny?: string[]
  }
  allowedDeprecatedVersions?: Record<string, string>
  requiredScripts?: string[]
  updateConfig?: {
    ignoreDependencies?: string[]
  }
}

// -----------------------------------------------------------------------------
// Shared base types (fields available in both root and package configs)
// -----------------------------------------------------------------------------

/** Base fields shared between root and package configs */
type BasePackageJsonFields = {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  homepage?: string
  bugs?: Bugs
  license?: string
  author?: Person
  contributors?: Person[]
  repository?: Repository
  main?: string
  module?: string
  types?: string
  typings?: string
  files?: string[]
  exports?: Record<string, ExportsEntry>
  /** Node.js subpath imports (private path aliases, e.g. `#utils/*`) */
  imports?: Record<string, string>
  type?: 'module' | 'commonjs'
  bin?: string | Record<string, string>
  man?: string | string[]
  directories?: {
    lib?: string
    bin?: string
    man?: string
    doc?: string
    example?: string
    test?: string
  }
  scripts?: Record<string, string>
  config?: Record<string, unknown>
  engines?: {
    node?: string
    npm?: string
    pnpm?: string
    yarn?: string
  }
  os?: string[]
  cpu?: string[]
  private?: boolean
  publishConfig?: {
    access?: 'public' | 'restricted'
    registry?: string
    tag?: string
    exports?: Record<string, ExportsEntry>
    [key: string]: unknown
  }
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  sideEffects?: boolean | string[]
  browser?: string | Record<string, string | false>
  funding?: Funding | Funding[]
}

/** Base config with typed dependencies (shared logic) */
type TypedDepsConfig<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = {
  dependencies?: ValidDep<TCatalog, TWorkspace>[]
  devDependencies?: ValidDep<TCatalog, TWorkspace>[]
  peerDependencies?: { [K in keyof TCatalog]?: PeerDepRangeStrict | string }
}

// -----------------------------------------------------------------------------
// PNPM-specific types
// -----------------------------------------------------------------------------

/** PNPM root package.json config */
type PnpmRootConfig<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = BasePackageJsonFields &
  TypedDepsConfig<TCatalog, TWorkspace> & {
    /** Workspace configuration - for PNPM, catalog is typically in pnpm-workspace.yaml */
    workspaces?: string[] | { packages?: string[]; catalog?: TCatalog }
    /** PNPM-specific namespace (root-only) */
    pnpm?: PnpmNamespaceConfig
    /** Yarn/npm resolutions (also works in PNPM) */
    resolutions?: Record<string, string>
  }

/** PNPM workspace package config - excludes root-only fields */
type PnpmPackageConfig<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = BasePackageJsonFields & TypedDepsConfig<TCatalog, TWorkspace>

// -----------------------------------------------------------------------------
// Bun-specific types
// -----------------------------------------------------------------------------

/** Bun root package.json config */
type BunRootConfig<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = BasePackageJsonFields &
  TypedDepsConfig<TCatalog, TWorkspace> & {
    /**
     * Workspace configuration with catalogs.
     * https://bun.com/docs/pm/workspaces
     * https://bun.com/docs/pm/catalogs
     */
    workspaces?:
      | string[]
      | {
          packages?: string[]
          catalog?: TCatalog
          catalogs?: Record<string, Record<string, string>>
        }
    /** Packages allowed to run lifecycle scripts (Bun-specific, root-only) */
    trustedDependencies?: string[]
    /** Override dependency versions (npm-style) */
    overrides?: Record<string, string>
    /** Override dependency versions (Yarn-style) */
    resolutions?: Record<string, string>
    /**
     * Patched dependency map for Bun.
     * https://bun.com/docs/pm/cli/patch
     */
    patchedDependencies?: Record<string, string>
    /**
     * Bun version catalog (top-level).
     * https://bun.com/docs/pm/catalogs
     */
    catalog?: Record<string, string>
    /**
     * Bun named version catalogs (top-level).
     * https://bun.com/docs/pm/catalogs
     */
    catalogs?: Record<string, Record<string, string>>
  }

/** Bun workspace package config - excludes root-only fields */
type BunPackageConfig<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = BasePackageJsonFields & TypedDepsConfig<TCatalog, TWorkspace>

// -----------------------------------------------------------------------------
// Context types
// -----------------------------------------------------------------------------

/** Base context for package.json generation */
type PackageJsonContextBase<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = {
  catalog: TCatalog
  workspacePackages: TWorkspace
  /** Validation configuration for enforcing dependency semantics */
  validation?: ValidationConfig
}

/** PNPM context */
type PnpmContext<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = PackageJsonContextBase<TCatalog, TWorkspace> & {
  packageManager: 'pnpm'
  packageManagerVersion: string
}

/** Bun context */
type BunContext<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = PackageJsonContextBase<TCatalog, TWorkspace> & {
  packageManager: 'bun'
  packageManagerVersion: string
}

// -----------------------------------------------------------------------------
// Builder return types
// -----------------------------------------------------------------------------

/** PNPM package.json builder */
type PnpmPackageJsonBuilder<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = {
  /** Generate root package.json with PNPM-specific fields */
  root: (config: PnpmRootConfig<TCatalog, TWorkspace>) => string
  /** Generate workspace package.json (no root-only fields allowed) */
  package: (config: PnpmPackageConfig<TCatalog, TWorkspace>) => string
}

/** Bun package.json builder */
type BunPackageJsonBuilder<
  TCatalog extends Record<string, string>,
  TWorkspace extends readonly string[],
> = {
  /** Generate root package.json with Bun-specific fields */
  root: (config: BunRootConfig<TCatalog, TWorkspace>) => string
  /** Generate workspace package.json (no root-only fields allowed) */
  package: (config: BunPackageConfig<TCatalog, TWorkspace>) => string
}

// -----------------------------------------------------------------------------
// Implementation helpers
// -----------------------------------------------------------------------------

/** Build a package.json string from config (internal implementation) */
// oxlint-disable-next-line overeng/named-args -- internal helper with clear parameter semantics
const buildPackageJson = (
  config: Record<string, unknown>,
  context: PackageJsonContext,
  options: { packageManager?: string; isRoot?: boolean; validation?: ValidationConfig },
): string => {
  const { dependencies, devDependencies, peerDependencies, exports, ...restConfig } =
    config as PackageJsonWithContextConfig & { exports?: Record<string, ExportsEntry> }

  const packageName = (config.name as string | undefined) ?? '<unknown>'

  // Resolve dependencies
  const resolvedDeps = resolveDependencies(dependencies, packageName, context)
  const resolvedDevDeps = resolveDependencies(devDependencies, packageName, context)
  const resolvedPeerDeps = resolvePeerDependencies(peerDependencies, packageName, context)

  // Sort exports
  const sortedExports = sortExports(exports)

  // Build the package.json object
  const packageJson: Record<string, unknown> = {
    ...restConfig,
    ...(resolvedDeps !== undefined && { dependencies: resolvedDeps }),
    ...(resolvedDevDeps !== undefined && { devDependencies: resolvedDevDeps }),
    ...(resolvedPeerDeps !== undefined && { peerDependencies: resolvedPeerDeps }),
    ...(sortedExports !== undefined && { exports: sortedExports }),
  }

  // Add packageManager field for root
  if (options.isRoot && options.packageManager) {
    packageJson.packageManager = options.packageManager
  }

  // Validate required fields for non-private packages
  if (packageJson.private !== true) {
    if (packageJson.name === undefined) {
      console.warn('Warning: Package is not private but missing a name')
    }
    if (packageJson.version === undefined) {
      console.warn('Warning: Package is not private but missing a version')
    }
  }

  // Run semantic validation if configured
  if (options.validation) {
    const { validate, excludePackages = [], throwOnError = true } = options.validation

    // Skip excluded packages
    if (!matchesAnyPattern({ name: packageName, patterns: excludePackages }) && validate) {
      const deps: DepsToValidate = {
        ...(resolvedDeps !== undefined && { dependencies: resolvedDeps }),
        ...(resolvedDevDeps !== undefined && { devDependencies: resolvedDevDeps }),
        ...(resolvedPeerDeps !== undefined && { peerDependencies: resolvedPeerDeps }),
      }

      const issues = validate(packageName, deps)

      // Log warnings
      const warnings = issues.filter((i) => i.severity === 'warning')
      if (warnings.length > 0) {
        console.warn(formatValidationIssues(warnings))
      }

      // Throw on errors (unless disabled)
      if (throwOnError) {
        assertNoValidationErrors(issues)
      }
    }
  }

  // Add marker and sort fields
  const withMarker = sortObjectKeys(
    {
      $genie: true,
      ...packageJson,
    },
    FIELD_ORDER,
  )

  return JSON.stringify(withMarker, null, 2)
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Creates a type-safe package.json builder with package manager awareness.
 *
 * Returns an object with two helpers:
 * - `root()` - For root package.json with package-manager-specific fields
 * - `package()` - For workspace packages (strict, no root-only fields)
 *
 * @example
 * ```ts
 * // genie/repo.ts
 * export const catalog = {
 *   effect: '3.12.0',
 *   '@effect/platform': '0.90.0',
 *   react: '19.0.0',
 * } as const
 *
 * export const workspacePackagePatterns = ['@myorg/*'] as const
 *
 * export const pkg = createPackageJson({
 *   packageManager: 'pnpm',
 *   packageManagerVersion: '9.15.0',
 *   catalog,
 *   workspacePackages: workspacePackagePatterns,
 * })
 *
 * // Root package.json.genie.ts
 * import { catalog, pkg } from './genie/repo.ts'
 *
 * export default pkg.root({
 *   name: 'my-monorepo',
 *   private: true,
 *   workspaces: { packages: ['packages/*'], catalog },
 *   pnpm: { patchedDependencies: { ... } }, // ✓ PNPM-specific, root-only
 *   devDependencies: ['typescript'],
 * })
 *
 * // Workspace package.json.genie.ts
 * import { pkg } from '../../../genie/repo.ts'
 *
 * export default pkg.package({
 *   name: '@myorg/utils',
 *   version: '1.0.0',
 *   dependencies: ['effect'],
 *   // pnpm: { ... }, // ❌ Type error! Not allowed in package
 * })
 * ```
 */
export function createPackageJson<
  const TCatalog extends Record<string, string>,
  const TWorkspace extends readonly string[],
>(context: PnpmContext<TCatalog, TWorkspace>): PnpmPackageJsonBuilder<TCatalog, TWorkspace>

export function createPackageJson<
  const TCatalog extends Record<string, string>,
  const TWorkspace extends readonly string[],
>(context: BunContext<TCatalog, TWorkspace>): BunPackageJsonBuilder<TCatalog, TWorkspace>

// oxlint-disable-next-line overeng/jsdoc-require-exports -- JSDoc is on the first overload declaration above
export function createPackageJson<
  const TCatalog extends Record<string, string>,
  const TWorkspace extends readonly string[],
>(
  context: PnpmContext<TCatalog, TWorkspace> | BunContext<TCatalog, TWorkspace>,
): PnpmPackageJsonBuilder<TCatalog, TWorkspace> | BunPackageJsonBuilder<TCatalog, TWorkspace> {
  const runtimeContext: PackageJsonContext = {
    catalog: context.catalog,
    workspacePackages: context.workspacePackages,
  }

  const packageManagerString = `${context.packageManager}@${context.packageManagerVersion}`
  const validation = context.validation

  return {
    root: (config: Record<string, unknown>): string => {
      return buildPackageJson(config, runtimeContext, {
        packageManager: packageManagerString,
        isRoot: true,
        ...(validation !== undefined && { validation }),
      })
    },
    package: (config: Record<string, unknown>): string => {
      return buildPackageJson(config, runtimeContext, {
        isRoot: false,
        ...(validation !== undefined && { validation }),
      })
    },
  }
}
