/**
 * Type-safe catalog definition with duplicate/conflict detection.
 *
 * Helps detect issues when extending a base catalog:
 * - Duplicate: same package + same version → warning
 * - Conflict: same package + different version → error
 */

/** Base catalog type - a record of package names to version strings */
export type CatalogInput = Record<string, string>

/**
 * Type-level brand key for catalogs.
 *
 * Exported as a value so TypeScript can reference it in declaration files across project
 * boundaries. Without this export, TS4023 "cannot be named" errors occur.
 */
export const CatalogBrand: unique symbol = Symbol('CatalogBrand')

/** Type alias for the brand symbol type */
export type CatalogBrandType = typeof CatalogBrand

/**
 * Branded catalog type to distinguish validated catalogs.
 * Uses a symbol key which doesn't interfere with Record<string, string> compatibility.
 */
export type Catalog<T extends CatalogInput = CatalogInput> = Readonly<T> & {
  readonly [CatalogBrand]: T
  /**
   * Pick multiple packages from the catalog and return as a dependency object.
   * Useful for spreading into dependencies/devDependencies.
   *
   * @example
   * ```ts
   * devDependencies: {
   *   ...catalog.pick('@overeng/utils', 'effect'),
   * }
   * ```
   */
  pick<K extends keyof T>(...keys: K[]): { [P in K]: T[P] }
  /**
   * Generate peerDependencies object with `^` version prefix.
   * Useful for library packages that expose dependencies as peer deps.
   *
   * @example
   * ```ts
   * peerDependencies: catalog.peers('effect', '@effect/platform'),
   * // → { effect: '^3.19.14', '@effect/platform': '^0.94.1' }
   * ```
   */
  peers<K extends keyof T>(...keys: K[]): { [P in K]: string }
}

/** Configuration for extending an existing catalog */
export type ExtendedCatalogInput<TBase extends CatalogInput = CatalogInput> = {
  /** Base catalog(s) to extend from */
  extends: Catalog<TBase> | readonly Catalog[]
  /** New packages to add (will be checked for duplicates/conflicts) */
  packages: CatalogInput
}

/** Error thrown when a catalog has conflicting version definitions */
export class CatalogConflictError extends Error {
  public readonly packageName: string
  public readonly baseVersion: string
  public readonly newVersion: string

  constructor(args: { packageName: string; baseVersion: string; newVersion: string }) {
    const { packageName, baseVersion, newVersion } = args
    super(
      `Catalog conflict for "${packageName}": base has "${baseVersion}" but extending with "${newVersion}"`,
    )
    this.packageName = packageName
    this.baseVersion = baseVersion
    this.newVersion = newVersion
    this.name = 'CatalogConflictError'
  }
}

/** Creates a pick function for a catalog object */
const createPickFn =
  <T extends CatalogInput>(catalog: T) =>
  <K extends keyof T>(...keys: K[]): { [P in K]: T[P] } => {
    const result = {} as { [P in K]: T[P] }
    for (const key of keys) {
      result[key] = catalog[key]
    }
    return result
  }

/** Creates a peers function for a catalog object (versions with ^ prefix) */
const createPeersFn =
  <T extends CatalogInput>(catalog: T) =>
  <K extends keyof T>(...keys: K[]): { [P in K]: string } => {
    const result = {} as { [P in K]: string }
    for (const key of keys) {
      result[key] = `^${catalog[key]}`
    }
    return result
  }

/** Adds pick/peers methods as non-enumerable properties and freezes the catalog */
const finalizeCatalog = <T extends CatalogInput>(catalog: T): Catalog<T> => {
  Object.defineProperty(catalog, 'pick', {
    value: createPickFn(catalog),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(catalog, 'peers', {
    value: createPeersFn(catalog),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(catalog) as Catalog<T>
}

/**
 * Creates a type-safe catalog with optional duplicate/conflict detection.
 *
 * Two signatures:
 * 1. `defineCatalog({ pkg: 'version' })` - standalone catalog
 * 2. `defineCatalog({ extends: baseCatalog, packages: { ... } })` - extended catalog
 *
 * When extending:
 * - Duplicate (same pkg + same version): Console warning, proceeds
 * - Conflict (same pkg + different version): Throws {@link CatalogConflictError}
 *
 * @example
 * ```ts
 * // Standalone catalog
 * const baseCatalog = defineCatalog({
 *   effect: '3.19.14',
 *   '@effect/platform': '0.94.1',
 * })
 *
 * // Extended catalog with detection
 * const extendedCatalog = defineCatalog({
 *   extends: baseCatalog,
 *   packages: {
 *     '@effect/ai-openai': '0.37.2',  // new - OK
 *     effect: '3.19.14',               // duplicate - WARN
 *     // '@effect/platform': '0.95.0', // conflict - ERROR
 *   },
 * })
 *
 * // Multiple bases
 * const merged = defineCatalog({
 *   extends: [baseCatalog, otherCatalog],
 *   packages: { ... },
 * })
 * ```
 */
export function defineCatalog<const T extends CatalogInput>(input: T): Catalog<T>
export function defineCatalog<const TBase extends CatalogInput, const TNew extends CatalogInput>(
  input: { extends: Catalog<TBase>; packages: TNew },
): Catalog<TBase & TNew>
export function defineCatalog<const TNew extends CatalogInput>(
  input: { extends: readonly Catalog<any>[]; packages: TNew },
): Catalog<CatalogInput & TNew>
export function defineCatalog<const T extends CatalogInput>(
  input: T | ExtendedCatalogInput,
): Catalog<T> {
  if (!('extends' in input && 'packages' in input)) {
    // Standalone catalog - add pick method and freeze
    return finalizeCatalog({ ...input })
  }

  // Extended catalog - merge and validate
  const bases = Array.isArray(input.extends) ? input.extends : [input.extends]
  const merged: Record<string, string> = {}

  // Merge all base catalogs (skip non-string values like the pick method)
  for (const base of bases) {
    for (const pkg of Object.keys(base)) {
      const version = base[pkg]
      if (typeof version !== 'string') continue
      if (pkg in merged && merged[pkg] !== version) {
        // Conflict between bases
        throw new CatalogConflictError({
          packageName: pkg,
          baseVersion: merged[pkg]!,
          newVersion: version,
        })
      }
      merged[pkg] = version
    }
  }

  // Check and merge new packages
  for (const [pkg, version] of Object.entries(input.packages)) {
    if (pkg in merged) {
      if (merged[pkg] === version) {
        // Duplicate - warn but continue
        console.warn(
          `[defineCatalog] Duplicate: "${pkg}@${version}" already defined in base catalog`,
        )
      } else {
        // Conflict - throw
        throw new CatalogConflictError({
          packageName: pkg,
          baseVersion: merged[pkg]!,
          newVersion: version,
        })
      }
    }
    merged[pkg] = version
  }

  // Add pick method and freeze
  return finalizeCatalog(merged) as Catalog<T>
}
