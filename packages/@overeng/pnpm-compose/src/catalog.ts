import { FileSystem } from '@effect/platform'
import { Array as A, Effect, Option, Record, Schema } from 'effect'

/** A catalog is a record of package name to version */
export type Catalog = Record<string, string>

/** Result of reading a catalog from a repo */
export interface RepoCatalog {
  repoName: string
  repoPath: string
  catalog: Catalog
  source: 'genie/repo.ts' | 'pnpm-workspace.yaml' | 'package.json'
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

/** Read catalog from a repo's pnpm-workspace.yaml */
export const readPnpmWorkspaceCatalog = ({
  repoName,
  repoPath,
}: {
  repoName: string
  repoPath: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspacePath = `${repoPath}/pnpm-workspace.yaml`

    const exists = yield* fs.exists(workspacePath)
    if (!exists) {
      return Option.none<RepoCatalog>()
    }

    const content = yield* fs.readFileString(workspacePath)

    // Simple YAML parsing for catalog section
    const catalogMatch = content.match(/^catalog:\s*\n((?:\s+.+\n?)*)/m)
    if (!catalogMatch) {
      return Option.none<RepoCatalog>()
    }

    const catalogLines = catalogMatch[1]?.split('\n').filter((line) => line.trim()) ?? []
    const catalog: Catalog = {}

    for (const line of catalogLines) {
      // Match: "  package-name: version" or "  \"@scope/package\": version"
      const match = line.match(/^\s+["']?([^"':]+)["']?:\s*["']?([^"'\s]+)["']?/)
      if (match && match[1] && match[2]) {
        catalog[match[1]] = match[2]
      }
    }

    if (Object.keys(catalog).length === 0) {
      return Option.none<RepoCatalog>()
    }

    return Option.some<RepoCatalog>({
      repoName,
      repoPath,
      catalog,
      source: 'pnpm-workspace.yaml',
    })
  }).pipe(Effect.withSpan('readPnpmWorkspaceCatalog'))

/** Read catalog from a repo (tries genie first, then pnpm-workspace.yaml) */
export const readRepoCatalog = ({ repoName, repoPath }: { repoName: string; repoPath: string }) =>
  Effect.gen(function* () {
    // Try genie/repo.ts first
    const genieCatalog = yield* readGenieRepoCatalog({ repoName, repoPath })
    if (Option.isSome(genieCatalog)) {
      return genieCatalog
    }

    // Fall back to pnpm-workspace.yaml
    return yield* readPnpmWorkspaceCatalog({ repoName, repoPath })
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
