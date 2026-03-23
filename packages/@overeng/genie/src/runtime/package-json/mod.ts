/**
 * Type-safe package.json generator
 *
 * Simple factories that return `GenieOutput<T>` for composability.
 * Dependency versions are managed externally via catalog imports.
 *
 * Reference: https://github.com/sindresorhus/type-fest/blob/main/source/package-json.d.ts
 */

import { createGenieOutput } from '../core.ts'
import type { GenieContext, GenieOutput, Strict } from '../core.ts'
import type { PnpmPackageClosureConfig } from '../pnpm-workspace/mod.ts'
import { projectPnpmPackageClosure } from '../pnpm-workspace/mod.ts'
import { relativeRepoPath, rootWorkspaceMemberPathsFromPackages } from '../workspace-graph.ts'
import { PackageJsonCompositionBrand, type PackageJsonComposition } from './catalog.ts'
import {
  validatePackageRecompositionForPackage,
  validateWorkspaceMetadataPresenceForPackageJson,
  validateWorkspaceMetadataForPackageJson,
} from './validators/recompose.ts'

// Re-export catalog utilities (useful for defining version catalogs)
export { defineCatalog, CatalogConflictError, type Catalog, type CatalogInput } from './catalog.ts'

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
  'dependenciesMeta',
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
  /** Dependency metadata (e.g. injected workspace deps for singleton resolution) */
  dependenciesMeta?: Record<string, { injected?: boolean }>
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
   * Bun patched dependencies (top-level).
   *
   * For pnpm, use `pnpm.patchedDependencies` instead.
   *
   * Paths can be:
   * - Local: `./patches/pkg.patch` (relative to this package)
   * - Repo-relative: `packages/@overeng/utils/patches/pkg.patch` (resolved at stringify time)
   */
  patchedDependencies?: Record<string, string>
  /**
   * pnpm-specific configuration.
   *
   * Use this field to configure pnpm-specific options like
   * `patchedDependencies`.
   *
   * In the current workspace model, the authoritative `pnpm-lock.yaml` lives
   * at the selected topology root rather than inside workspace member
   * packages.
   */
  pnpm?: {
    overrides?: Record<string, string>
    patchedDependencies?: Record<string, string>
    onlyBuiltDependencies?: readonly string[]
    neverBuiltDependencies?: readonly string[]
  }
}

/** Stable workspace identity used during import-time package composition. */
export type WorkspaceIdentity = {
  repoName: string
  memberPath: string
  pnpmPackageClosure?: PnpmPackageClosureConfig
}

/** Static workspace-composition metadata stored in non-emitted generator meta. */
export type WorkspaceMetadata = WorkspaceIdentity & {
  deps: readonly WorkspacePackageLike[]
}

/** Emitted repository aggregate manifest shape. */
export type AggregatePackageJsonData = {
  name: string
  workspaces: readonly string[]
  private: true
  packageManager: string
}

/** Package-level metadata wrapper attached to generators that participate in workspace recomposition. */
export type WorkspaceMeta = {
  workspace: WorkspaceMetadata
}

/** Minimal shape needed to compose emitted package data with non-emitted workspace metadata. */
export type WorkspacePackageLike = {
  data: PackageJsonData
  meta: WorkspaceMeta
}

/** Package.json genie output that carries workspace-composition metadata. */
export type WorkspacePackage = GenieOutput<PackageJsonData, WorkspaceMeta>

type PackageJsonComposedData = Omit<
  PackageJsonData,
  'dependencies' | 'devDependencies' | 'peerDependencies'
> & {
  dependencies?: never
  devDependencies?: never
  peerDependencies?: never
}

type PackageJsonMetadataInput<TMeta extends object = {}> = TMeta & {
  workspace?: never
  composition?: never
  [PackageJsonCompositionBrand]?: never
}

const isPackageJsonComposition = (meta: unknown): meta is PackageJsonComposition =>
  typeof meta === 'object' && meta !== null && PackageJsonCompositionBrand in meta

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

  for (const exportPath of paths) {
    sorted[exportPath] = sortExportConditions(exports[exportPath]!)
  }
  return sorted
}

/** Prefixes for internal dependencies that use absolute repo paths */
const INTERNAL_FILE_PREFIX = 'file:packages/'
const INTERNAL_LINK_PREFIX = 'link:packages/'
const INTERNAL_REPO_LINK_PREFIX = 'link:repos/'

/**
 * Resolve dependency versions, converting internal repo-absolute paths to relative paths.
 * Handles `file:packages/...`, `link:packages/...`, and `link:repos/...` (cross-repo) prefixes.
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
    if (version.startsWith(INTERNAL_FILE_PREFIX) === true) {
      const targetLocation = version.slice('file:'.length)
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: targetLocation,
      })
      resolved[name] = `file:${relativePath}`
    } else if (
      version.startsWith(INTERNAL_LINK_PREFIX) === true ||
      version.startsWith(INTERNAL_REPO_LINK_PREFIX) === true
    ) {
      const targetLocation = version.slice('link:'.length)
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: targetLocation,
      })
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
  for (const [pkg, patchPath] of Object.entries(patches).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (patchPath.startsWith('./') === true || patchPath.startsWith('../') === true) {
      // Already relative to current package
      resolved[pkg] = patchPath
    } else {
      // Repo-relative path - compute relative path from current location
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: patchPath,
      })
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
 * @param genieMarker - Structured $genie metadata object (defaults to `true` for backwards compat)
 */
const buildPackageJson = <T extends PackageJsonData>({
  data,
  location,
  genieMarker,
}: {
  data: T
  location: string
  genieMarker?: Record<string, unknown>
}): Record<string, unknown> => {
  const sorted = {
    ...data,
    ...(data.exports !== undefined && { exports: sortExports(data.exports) }),
    ...(data.dependencies !== undefined && {
      dependencies: resolveDeps({
        deps: data.dependencies,
        currentLocation: location,
      }),
    }),
    ...(data.devDependencies !== undefined && {
      devDependencies: resolveDeps({
        deps: data.devDependencies,
        currentLocation: location,
      }),
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
    ...(data.pnpm !== undefined && {
      pnpm: {
        ...data.pnpm,
        ...(data.pnpm.patchedDependencies !== undefined && {
          patchedDependencies: resolvePatchPaths({
            patches: data.pnpm.patchedDependencies,
            currentLocation: location,
          }),
        }),
      },
    }),
    ...(data.scripts !== undefined && {
      scripts: resolveScripts({ scripts: data.scripts, location }),
    }),
  }

  return sortObjectKeys({
    obj: {
      $genie: genieMarker ?? true,
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
 * @example Coupled dependency composition
 * ```ts
 * import utilsPkg from '../utils/package.json.genie.ts'
 * import { catalog, packageJson } from '@overeng/genie'
 *
 * const composition = catalog.compose({
 *   workspace: {
 *     repoName: 'my-repo',
 *     memberPath: 'packages/app',
 *   },
 *   dependencies: {
 *     workspace: [utilsPkg],
 *     external: catalog.pick('effect'),
 *   },
 *   mode: 'install',
 * })
 *
 * export default packageJson(
 *   {
 *     name: '@myorg/app',
 *   },
 *   composition,
 * )
 * ```
 */
function createPackageJson<const T extends PackageJsonData>(
  data: Strict<T, PackageJsonData>,
): GenieOutput<T>
function createPackageJson<const T extends PackageJsonComposedData>(
  data: Strict<T, PackageJsonComposedData>,
  composition: PackageJsonComposition,
): GenieOutput<T, WorkspaceMeta>
function createPackageJson<const T extends PackageJsonData, const TMeta extends object>(
  data: Strict<T, PackageJsonData>,
  meta: PackageJsonMetadataInput<TMeta>,
): GenieOutput<T, TMeta>
/**
 * Genie convention: the first arg is emitted data and the second arg is
 * non-emitted metadata.
 *
 * For package.json generators, workspace metadata must flow through the
 * branded composition object returned by `catalog.compose(...)` so emitted
 * dependencies and workspace closure stay coupled. Pass plain metadata only
 * for unrelated concerns.
 */
// oxlint-disable-next-line overeng/named-args
function createPackageJson<const T extends PackageJsonData, const TMeta>(
  data: Strict<T, PackageJsonData>,
  meta?: TMeta,
) {
  const hasManualDepsWithComposition =
    isPackageJsonComposition(meta) === true &&
    (data.dependencies !== undefined ||
      data.devDependencies !== undefined ||
      data.peerDependencies !== undefined)
  const hasRawWorkspaceMetadata =
    isPackageJsonComposition(meta) === false &&
    meta !== undefined &&
    typeof meta === 'object' &&
    meta !== null &&
    'workspace' in meta &&
    typeof meta.workspace === 'object' &&
    meta.workspace !== null
  const hasWrappedComposition =
    isPackageJsonComposition(meta) === false &&
    meta !== undefined &&
    typeof meta === 'object' &&
    meta !== null &&
    'composition' in meta
  const composition = isPackageJsonComposition(meta) === true ? meta : undefined

  const effectiveData =
    composition !== undefined
      ? ({
          ...data,
          ...(Object.keys(composition.dependencies).length === 0
            ? {}
            : { dependencies: composition.dependencies }),
          ...(Object.keys(composition.devDependencies).length === 0
            ? {}
            : { devDependencies: composition.devDependencies }),
          ...(Object.keys(composition.peerDependencies).length === 0
            ? {}
            : { peerDependencies: composition.peerDependencies }),
        } satisfies PackageJsonData)
      : data

  const effectiveMeta =
    composition !== undefined
      ? ({ workspace: composition.workspace } satisfies WorkspaceMeta)
      : meta

  const effectiveWorkspaceMeta =
    effectiveMeta !== undefined &&
    typeof effectiveMeta === 'object' &&
    effectiveMeta !== null &&
    'workspace' in effectiveMeta &&
    typeof effectiveMeta.workspace === 'object' &&
    effectiveMeta.workspace !== null
      ? (effectiveMeta.workspace as WorkspaceMetadata)
      : undefined

  return createGenieOutput({
    data: effectiveData,
    stringify: (ctx: GenieContext) => {
      const genieMarker: Record<string, unknown> = {
        source: 'package.json.genie.ts',
        warning: 'DO NOT EDIT - changes will be overwritten',
      }

      /**
       * Embed the workspace closure so Nix can read it from the generated package.json
       * at eval time without import-from-derivation (IFD).
       * Future alternative: NixOS/nix#15380 (builtins.wasm) could compute this natively.
       */
      if (effectiveWorkspaceMeta !== undefined) {
        const closure = projectPnpmPackageClosure({
          pkg: { data: effectiveData, meta: { workspace: effectiveWorkspaceMeta } },
        })
        genieMarker.workspaceClosureDirs = closure.workspaceClosureDirs
      }

      return (
        JSON.stringify(
          buildPackageJson({ data: effectiveData, location: ctx.location, genieMarker }),
          null,
          2,
        ) + '\n'
      )
    },
    validate: (ctx: GenieContext) => [
      ...(effectiveData.name !== undefined
        ? validatePackageRecompositionForPackage({ ctx, pkgName: effectiveData.name })
        : []),
      ...(effectiveWorkspaceMeta === undefined
        ? validateWorkspaceMetadataPresenceForPackageJson({
            data: effectiveData,
          })
        : []),
      ...(effectiveWorkspaceMeta === undefined
        ? []
        : validateWorkspaceMetadataForPackageJson({
            data: effectiveData,
            metadata: effectiveWorkspaceMeta,
          })),
      ...(hasManualDepsWithComposition === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(composition)',
              message:
                'Do not define dependencies/devDependencies/peerDependencies in packageJson(data, composition). Put them into the composition so emitted deps and workspace metadata stay coupled.',
              rule: 'package-json-composition-coupling',
            },
          ]
        : []),
      ...(hasRawWorkspaceMetadata === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(workspace metadata)',
              message:
                'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
              rule: 'package-json-workspace-composition-required',
            },
          ]
        : []),
      ...(hasWrappedComposition === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(composition)',
              message:
                'Do not wrap the composition object as { composition }. Pass packageJson(data, composition) so the authoring boundary stays crisp.',
              rule: 'package-json-wrapped-composition-disallowed',
            },
          ]
        : []),
    ],
    ...(effectiveMeta === undefined ? {} : { meta: effectiveMeta }),
  })
}

/**
 * Default package manager emitted for aggregate manifests.
 *
 * Aggregates are repository coordination files, not package-level authoring
 * surfaces, so this stays centralized instead of being repeated by callers.
 */
const DEFAULT_AGGREGATE_PACKAGE_MANAGER = 'pnpm@11.0.0-beta.2'

/**
 * Project an aggregate manifest from package metadata for an explicit repo view.
 *
 * The aggregate manifest is not a runnable package and does not own
 * dependencies, scripts, exports, or publish settings. It exists only to
 * declare related workspace members. Constraining it prevents root-level
 * dependency and tooling creep, while actual package ownership remains with
 * real workspace packages.
 *
 * `extraMembers` allows adding non-genie-managed workspace member paths
 * (e.g. standalone examples) that cannot be derived from package metadata.
 */
const aggregatePackageJsonFromPackages = ({
  packages,
  name,
  repoName,
  extraMembers = [],
}: {
  packages: readonly WorkspacePackageLike[]
  name: string
  repoName: string
  extraMembers?: readonly string[]
}) => {
  const projectedMembers = rootWorkspaceMemberPathsFromPackages({ packages, repoName })
  const allMembers =
    extraMembers.length === 0
      ? projectedMembers
      : [...new Set([...projectedMembers, ...extraMembers])].toSorted((a, b) => a.localeCompare(b))

  const aggregate: AggregatePackageJsonData = {
    name,
    private: true,
    packageManager: DEFAULT_AGGREGATE_PACKAGE_MANAGER,
    workspaces: allMembers,
  }

  return createGenieOutput({
    data: aggregate,
    stringify: (ctx: GenieContext) =>
      JSON.stringify(
        buildPackageJson({
          data: aggregate,
          location: ctx.location,
          genieMarker: {
            source: 'package.json.genie.ts',
            warning: 'DO NOT EDIT - changes will be overwritten',
          },
        }),
        null,
        2,
      ) + '\n',
  })
}

/** Package manifest authoring API plus constrained aggregate projection. */
export const packageJson = Object.assign(createPackageJson, {
  aggregateFromPackages: aggregatePackageJsonFromPackages,
}) as typeof createPackageJson & {
  aggregateFromPackages: typeof aggregatePackageJsonFromPackages
}
