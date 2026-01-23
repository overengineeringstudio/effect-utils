/**
 * Type-safe package.json generator
 *
 * Simple factories that return `GenieOutput<T>` for composability.
 * Dependency versions are managed externally via catalog imports.
 *
 * Reference: https://github.com/sindresorhus/type-fest/blob/main/source/package-json.d.ts
 */

import type { GenieOutput, Strict } from '../mod.ts'

// Re-export catalog utilities (useful for defining version catalogs)
export {
  CatalogBrand,
  defineCatalog,
  CatalogConflictError,
  type Catalog,
  type CatalogBrandType,
  type CatalogInput,
  type ExtendedCatalogInput,
} from './catalog.ts'

export {
  defineOverrides,
  definePatchedDependencies,
  prefixPatchPaths,
  OverrideConflictError,
  type OverridesInput,
  type ExtendedOverridesInput,
} from './overrides.ts'

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
  'patchedDependencies',
  'resolutions',
] as const

/**
 * Export condition ordering for package.json exports (matches syncpack sortExports convention).
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

/**
 * Patches registry type.
 * Keys are patch specifiers like `pkg@version`, values are repo-relative paths to patch files.
 *
 * @example
 * ```ts
 * const patches: PatchesRegistry = {
 *   'effect-distributed-lock@0.0.11': 'patches/effect-distributed-lock@0.0.11.patch',
 * }
 * ```
 */
export type PatchesRegistry = Record<string, string>

/**
 * Script value can be a string or a function that resolves at stringify time.
 * Functions receive the package location and return the script string.
 *
 * @example
 * ```ts
 * scripts: {
 *   build: 'tsc',  // static string
 *   postinstall: (location) => `patch -p1 < ${computePath(location)}/patches/foo.patch`,  // dynamic
 * }
 * ```
 */
export type ScriptValue = string | ((location: string) => string)

/** Package.json data structure */
export type PackageJsonData = {
  /** Package name */
  name?: string
  /** Package version (semver) */
  version?: string
  /** Short package description */
  description?: string
  /** Keywords for npm search */
  keywords?: readonly string[]
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
  /** npm scripts (values can be strings or functions resolved at stringify time) */
  scripts?: Record<string, ScriptValue>
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
  /** Tree-shaking side effects configuration */
  sideEffects?: boolean | string[]
  /** Browser field for bundlers */
  browser?: string | Record<string, string | false>
  /** Funding information */
  funding?: Funding | Funding[]
  /** Package manager for corepack */
  packageManager?: string
  /**
   * Bun/pnpm patched dependencies.
   *
   * Paths can be:
   * - Local: `./patches/pkg.patch` (relative to this package)
   * - Repo-relative: `packages/@overeng/utils/patches/pkg.patch` (resolved at stringify time)
   *
   * TODO: Re-embrace patchedDependencies once the bun bug is fixed.
   * See context/workarounds/bun-patched-dependencies.md for details.
   * Currently using postinstall scripts as a workaround via patchPostinstall().
   */
  patchedDependencies?: Record<string, string>
}

/** Workspace root package.json data (includes workspace-specific fields) */
export type WorkspaceRootData = PackageJsonData & {
  /** Workspace configuration */
  workspaces?: string[] | { packages?: string[]; catalog?: Record<string, string> }
  /** pnpm-specific configuration */
  pnpm?: {
    overrides?: Record<string, string>
    patchedDependencies?: Record<string, string>
    onlyBuiltDependencies?: readonly string[]
    neverBuiltDependencies?: readonly string[]
    packageExtensions?: Record<
      string,
      {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
    >
    peerDependencyRules?: {
      allowedVersions?: Record<string, string>
      ignoreMissing?: readonly string[]
      allowAny?: readonly string[]
    }
    allowedDeprecatedVersions?: Record<string, string>
    requiredScripts?: readonly string[]
    updateConfig?: {
      ignoreDependencies?: readonly string[]
    }
  }
  /** Yarn/npm resolutions */
  resolutions?: Record<string, string>
  /** Bun trusted dependencies */
  trustedDependencies?: string[]
  /** Bun/npm overrides */
  overrides?: Record<string, string>
  /** Bun/pnpm patched dependencies */
  patchedDependencies?: Record<string, string>
  /** Bun version catalog */
  catalog?: Record<string, string>
  /** Bun named version catalogs */
  catalogs?: Record<string, Record<string, string>>
}

/**
 * Sort object keys according to a defined order.
 * Keys in the order array appear first (in that order), then remaining keys alphabetically.
 */
const sortObjectKeys = <T extends Record<string, unknown>>({
  obj,
  order,
}: {
  obj: T
  order: readonly string[]
}): T => {
  const orderSet = new Set(order)
  const orderedKeys = order.filter((key) => key in obj)
  const remainingKeys = Object.keys(obj)
    .filter((key) => !orderSet.has(key))
    .toSorted()
  const sortedKeys = [...orderedKeys, ...remainingKeys]
  return Object.fromEntries(sortedKeys.map((key) => [key, obj[key]])) as T
}

/** Sort export conditions within an exports entry. */
const sortExportConditions = (entry: ExportsEntry): ExportsEntry => {
  if (typeof entry === 'string') return entry
  return sortObjectKeys({ obj: entry, order: EXPORT_CONDITION_ORDER })
}

/** Sort exports object - sort conditions within each entry. */
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
 * Compute relative path from one repo-relative location to another.
 * @param from - Source location (e.g., 'packages/@overeng/genie')
 * @param to - Target location (e.g., 'packages/@overeng/utils')
 * @returns Relative path (e.g., '../utils')
 */
const computeRelativePath = ({ from, to }: { from: string; to: string }): string => {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  // Find common prefix length
  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  // Build relative path: go up from 'from', then down to 'to'
  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const relativePath = '../'.repeat(upCount) + downPath

  return relativePath || '.'
}

/** Prefix for internal file dependencies that use absolute repo paths */
const INTERNAL_FILE_PREFIX = 'file:packages/'
/** Prefix for internal link dependencies that use absolute repo paths */
const INTERNAL_LINK_PREFIX = 'link:packages/'

/**
 * Resolve dependency versions, converting internal `file:packages/...` and `link:packages/...` paths to relative paths.
 * @param deps - Dependencies object
 * @param currentLocation - Current package's repo-relative location
 */
const resolveDeps = ({
  deps,
  currentLocation,
}: {
  deps: Record<string, string> | undefined
  currentLocation: string
}): Record<string, string> | undefined => {
  if (deps === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [name, version] of Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (version.startsWith(INTERNAL_FILE_PREFIX)) {
      // Convert absolute repo path to relative path
      const targetLocation = version.slice('file:'.length)
      const relativePath = computeRelativePath({ from: currentLocation, to: targetLocation })
      resolved[name] = `file:${relativePath}`
    } else if (version.startsWith(INTERNAL_LINK_PREFIX)) {
      // Convert absolute repo path to relative path for link: protocol
      const targetLocation = version.slice('link:'.length)
      const relativePath = computeRelativePath({ from: currentLocation, to: targetLocation })
      resolved[name] = `link:${relativePath}`
    } else {
      resolved[name] = version
    }
  }
  return resolved
}

/** Sort dependencies alphabetically (legacy, used when no resolution needed) */
const sortDeps = (deps: Record<string, string> | undefined): Record<string, string> | undefined => {
  if (deps === undefined) return undefined
  return Object.fromEntries(Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Resolve patch paths, converting repo-relative paths to package-relative paths.
 *
 * Paths starting with `./` are kept as-is (already relative to current package).
 * Other paths are treated as repo-relative and converted to relative paths.
 *
 * @param patches - Patched dependencies object
 * @param currentLocation - Current package's repo-relative location
 */
const resolvePatchPaths = ({
  patches,
  currentLocation,
}: {
  patches: Record<string, string> | undefined
  currentLocation: string
}): Record<string, string> | undefined => {
  if (patches === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [pkg, path] of Object.entries(patches).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('./') || path.startsWith('../')) {
      // Already relative to current package
      resolved[pkg] = path
    } else {
      // Repo-relative path - compute relative path from current location
      const relativePath = computeRelativePath({ from: currentLocation, to: path })
      resolved[pkg] = relativePath
    }
  }
  return resolved
}

/**
 * Resolve script values, calling functions with the current location.
 * @param scripts - Scripts object with string or function values
 * @param location - Current package's repo-relative location
 */
const resolveScripts = ({
  scripts,
  location,
}: {
  scripts: Record<string, ScriptValue> | undefined
  location: string
}): Record<string, string> | undefined => {
  if (scripts === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(scripts)) {
    resolved[name] = typeof value === 'function' ? value(location) : value
  }
  return resolved
}

/**
 * Build the final package.json object with sorting, resolution, and $genie marker.
 * @param data - Package data
 * @param location - Current package's repo-relative location (for resolving internal deps)
 */
const buildPackageJson = <T extends PackageJsonData>({
  data,
  location,
}: {
  data: T
  location: string
}): Record<string, unknown> => {
  const sorted = {
    ...data,
    ...(data.exports !== undefined && { exports: sortExports(data.exports) }),
    ...(data.dependencies !== undefined && {
      dependencies: resolveDeps({ deps: data.dependencies, currentLocation: location }),
    }),
    ...(data.devDependencies !== undefined && {
      devDependencies: resolveDeps({ deps: data.devDependencies, currentLocation: location }),
    }),
    ...(data.peerDependencies !== undefined && {
      peerDependencies: sortDeps(data.peerDependencies),
    }),
    ...(data.optionalDependencies !== undefined && {
      optionalDependencies: sortDeps(data.optionalDependencies),
    }),
    ...(data.patchedDependencies !== undefined && {
      patchedDependencies: resolvePatchPaths({
        patches: data.patchedDependencies,
        currentLocation: location,
      }),
    }),
    ...(data.scripts !== undefined && {
      scripts: resolveScripts({ scripts: data.scripts, location }),
    }),
  }

  return sortObjectKeys({
    obj: {
      $genie: true,
      ...sorted,
    },
    order: FIELD_ORDER,
  })
}

/**
 * Creates a package.json configuration for a workspace package.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files (e.g., peer dependency inheritance).
 *
 * @example
 * ```ts
 * import { packageJson } from '@overeng/genie'
 * import { catalog, privateDefaults } from '../../genie/shared.ts'
 *
 * export default packageJson({
 *   ...privateDefaults,
 *   name: '@myorg/utils',
 *   version: '1.0.0',
 *   dependencies: {
 *     effect: catalog.effect,
 *   },
 *   peerDependencies: {
 *     '@effect/platform': `^${catalog['@effect/platform']}`,
 *   },
 * })
 * ```
 *
 * @example Composing peer dependencies
 * ```ts
 * import { packageJson } from '@overeng/genie'
 * import utilsPkg from '../utils/package.json.genie.ts'
 *
 * export default packageJson({
 *   name: '@myorg/app',
 *   dependencies: { '@myorg/utils': 'workspace:*' },
 *   peerDependencies: {
 *     ...utilsPkg.data.peerDependencies,  // Inherit peer deps
 *   },
 * })
 * ```
 */
export const packageJson = <const T extends PackageJsonData>(
  data: Strict<T, PackageJsonData>,
): GenieOutput<T> => ({
  data,
  stringify: (ctx) =>
    JSON.stringify(buildPackageJson({ data, location: ctx.location }), null, 2) + '\n',
})

/**
 * Creates a package.json configuration for a workspace root.
 *
 * Similar to `packageJson` but includes workspace-specific fields like
 * `workspaces`, `pnpm`, `resolutions`, etc.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * import { workspaceRoot } from '@overeng/genie'
 * import { catalog } from './genie/catalog.ts'
 *
 * export default workspaceRoot({
 *   name: 'my-monorepo',
 *   private: true,
 *   packageManager: 'pnpm@9.15.0',
 *   workspaces: ['packages/*'],
 *   devDependencies: {
 *     typescript: catalog.typescript,
 *   },
 *   pnpm: {
 *     patchedDependencies: { ... },
 *   },
 * })
 * ```
 */
export const workspaceRoot = <const T extends WorkspaceRootData>(
  data: Strict<T, WorkspaceRootData>,
): GenieOutput<T> => ({
  data,
  stringify: (ctx) =>
    JSON.stringify(buildPackageJson({ data, location: ctx.location }), null, 2) + '\n',
})
