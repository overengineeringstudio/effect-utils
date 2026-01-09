import { FileSystem } from '@effect/platform'
import { Array as A, Effect, Option, Schema } from 'effect'

/** A catalog is a record of package name to version */
export type Catalog = Record<string, string>

/** Result of reading a catalog from a repo */
export interface RepoCatalog {
  repoName: string
  repoPath: string
  catalog: Catalog
  source: 'genie/repo.ts' | 'package.json'
}

/** Catalog conflict: same package with different versions */
export interface CatalogConflict {
  packageName: string
  versions: Array<{ repoName: string; version: string }>
  highestVersion: string
}

/** Read catalog from a repo's genie/repo.ts */
export const readGenieRepoCatalog = ({
  repoName,
  repoPath,
}: {
  repoName: string
  repoPath: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const geniePath = `${repoPath}/genie/repo.ts`

    const exists = yield* fs.exists(geniePath)
    if (!exists) {
      return Option.none<RepoCatalog>()
    }

    // Dynamic import the genie/repo.ts
    const genieModule = yield* Effect.tryPromise({
      // oxlint-disable-next-line import/no-dynamic-require -- intentional cache-busting for runtime config
      try: () => import(`${geniePath}?t=${Date.now()}`),
      catch: (error) => new CatalogReadError({ repoName, path: geniePath, cause: error }),
    })

    const catalog = genieModule.catalog as Catalog | undefined
    if (!catalog) {
      return Option.none<RepoCatalog>()
    }

    return Option.some<RepoCatalog>({
      repoName,
      repoPath,
      catalog,
      source: 'genie/repo.ts',
    })
  }).pipe(Effect.withSpan('readGenieRepoCatalog'))

/**
 * Read catalog from a repo's package.json
 * Bun supports catalogs in two locations:
 * 1. workspaces.catalog - e.g., { "workspaces": { "catalog": { "effect": "3.12.0" } } }
 * 2. Top-level catalog - e.g., { "catalog": { "effect": "3.12.0" } }
 */
export const readPackageJsonCatalog = ({
  repoName,
  repoPath,
}: {
  repoName: string
  repoPath: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packageJsonPath = `${repoPath}/package.json`

    const exists = yield* fs.exists(packageJsonPath)
    if (!exists) {
      return Option.none<RepoCatalog>()
    }

    const content = yield* fs.readFileString(packageJsonPath)
    const packageJson = yield* Effect.try({
      try: () => JSON.parse(content) as Record<string, unknown>,
      catch: (error) => new CatalogReadError({ repoName, path: packageJsonPath, cause: error }),
    })

    // Try workspaces.catalog first (bun's primary location)
    const workspaces = packageJson.workspaces as { catalog?: Catalog } | undefined
    if (workspaces?.catalog && typeof workspaces.catalog === 'object') {
      return Option.some<RepoCatalog>({
        repoName,
        repoPath,
        catalog: workspaces.catalog,
        source: 'package.json',
      })
    }

    // Fall back to top-level catalog
    const catalog = packageJson.catalog as Catalog | undefined
    if (catalog && typeof catalog === 'object') {
      return Option.some<RepoCatalog>({
        repoName,
        repoPath,
        catalog,
        source: 'package.json',
      })
    }

    return Option.none<RepoCatalog>()
  }).pipe(Effect.withSpan('readPackageJsonCatalog'))

/** Read catalog from a repo (tries genie first, then package.json) */
export const readRepoCatalog = ({ repoName, repoPath }: { repoName: string; repoPath: string }) =>
  Effect.gen(function* () {
    // Try genie/repo.ts first
    const genieCatalog = yield* readGenieRepoCatalog({ repoName, repoPath })
    if (Option.isSome(genieCatalog)) {
      return genieCatalog
    }

    // Fall back to package.json
    return yield* readPackageJsonCatalog({ repoName, repoPath })
  }).pipe(Effect.withSpan('readRepoCatalog'))

/** Find conflicts between multiple catalogs */
export const findCatalogConflicts = (catalogs: RepoCatalog[]): CatalogConflict[] => {
  // Group all versions by package name
  const packageVersions: Record<string, Array<{ repoName: string; version: string }>> = {}

  for (const repoCatalog of catalogs) {
    for (const [packageName, version] of Object.entries(repoCatalog.catalog)) {
      if (!packageVersions[packageName]) {
        packageVersions[packageName] = []
      }
      packageVersions[packageName].push({ repoName: repoCatalog.repoName, version })
    }
  }

  // Find packages with different versions
  const conflicts: CatalogConflict[] = []

  for (const [packageName, versions] of Object.entries(packageVersions)) {
    const uniqueVersions = new Set(versions.map((v) => v.version))
    if (uniqueVersions.size > 1) {
      // Find highest version (simple semver comparison)
      const highestVersion = A.reduce(Array.from(uniqueVersions), '0.0.0', (highest, version) =>
        compareVersions({ a: version, b: highest }) > 0 ? version : highest,
      )

      conflicts.push({
        packageName,
        versions,
        highestVersion,
      })
    }
  }

  return conflicts
}

/** Parse version string into numeric parts */
const parseVersion = (v: string) => {
  const parts = v.replace(/^[^0-9]*/, '').split(/[.-]/)
  return parts.map((p) => parseInt(p, 10) || 0)
}

/** Simple semver comparison (returns positive if a > b) */
const compareVersions = ({ a, b }: { a: string; b: string }): number => {
  const aParts = parseVersion(a)
  const bParts = parseVersion(b)

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aNum = aParts[i] ?? 0
    const bNum = bParts[i] ?? 0
    if (aNum !== bNum) {
      return aNum - bNum
    }
  }

  return 0
}

/** Error when reading catalog fails */
export class CatalogReadError extends Schema.TaggedError<CatalogReadError>()('CatalogReadError', {
  repoName: Schema.String,
  path: Schema.String,
  cause: Schema.Defect,
}) {
  override get message(): string {
    return `Failed to read catalog from ${this.repoName} at ${this.path}`
  }
}
