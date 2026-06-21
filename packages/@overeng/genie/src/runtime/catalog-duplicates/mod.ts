/**
 * Catalog duplicate-version detection via the pnpm lockfile.
 *
 * A catalog-managed package pins a single version, but transitive dependents
 * can still pull other versions into `pnpm-lock.yaml`, silently creating
 * duplicate singletons (bundle bloat plus module-identity hazards). This
 * validator flags any catalog package that resolves to more than one version.
 *
 * Remediation, in order of preference:
 * - in-range duplicates collapse with `pnpm dedupe` (force-newest);
 * - upstream-locked duplicates — a dependent hard-pins an out-of-range version
 *   that `pnpm dedupe` cannot collapse — must be acknowledged via
 *   `catalogDuplicateExceptions` with a reason and tracking issue.
 *
 * The exception list is the shared "blessing" primitive: anything unblessed is
 * an error, a blessing suppresses to a warning, and a blessing that no longer
 * matches a live duplicate is reported as stale.
 */

import { parseVersion } from '../semver/mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

// =============================================================================
// Lockfile Parser
// =============================================================================

/**
 * Collect every resolved version per package name from the `packages:` section
 * of a `pnpm-lock.yaml`.
 *
 * Unlike `parseResolvedVersionsFromLockfile` (which keeps only the first,
 * canonical entry per name), this retains the full set so duplicates surface.
 */
export const parseAllResolvedVersionsFromLockfile = (
  yamlContent: string,
): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>()
  const lines = yamlContent.split('\n')

  let inPackages = false

  for (const line of lines) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }
    if (inPackages === false) continue

    /* New top-level section ends the current packages block.
     * Don't break — workspace lockfiles can have multiple `packages:` sections. */
    if (/^\S/.test(line) === true && line !== 'packages:') {
      inPackages = false
      continue
    }

    /* Package metadata entry: `  'name@version':` or `  name@version:`.
     * Skip resolution-specific entries containing parentheses. */
    const pkgMatch = line.match(/^  '?([^'(]+@[^'(]+?)'?:$/)
    if (pkgMatch === null) continue

    const spec = pkgMatch[1]!
    const atIdx = spec.startsWith('@') === true ? spec.indexOf('@', 1) : spec.indexOf('@')
    if (atIdx <= 0) continue

    const name = spec.slice(0, atIdx)
    const version = spec.slice(atIdx + 1)
    const existing = result.get(name)
    if (existing === undefined) {
      result.set(name, new Set([version]))
    } else {
      existing.add(version)
    }
  }

  return result
}

/** Sort versions newest-first (descending semver, with a string tiebreaker). */
const byVersionDesc = (a: string, b: string): number => {
  const [aMajor, aMinor, aPatch] = parseVersion(a)
  const [bMajor, bMinor, bPatch] = parseVersion(b)
  if (aMajor !== bMajor) return bMajor - aMajor
  if (aMinor !== bMinor) return bMinor - aMinor
  if (aPatch !== bPatch) return bPatch - aPatch
  return b.localeCompare(a)
}

// =============================================================================
// Validation
// =============================================================================

/**
 * An acknowledged catalog duplicate — the shared blessing primitive.
 *
 * Use only for duplicates that cannot be collapsed (a dependent hard-pins an
 * out-of-range version). In-range duplicates should be fixed with `pnpm dedupe`
 * rather than blessed.
 */
export type CatalogDuplicateException = {
  /** Catalog package name allowed to resolve to multiple versions. */
  package: string
  /** Why the duplicate is unavoidable (e.g. `@opentui/core` hard-pins 7.2.0). */
  reason: string
  /** Tracking issue, e.g. `#820`. */
  issue?: string
}

/** Input for `validateCatalogDuplicates`. */
export type CatalogDuplicatesValidationArgs = {
  /** Catalog entries: package name → version. Defines which packages are gated. */
  catalog: Record<string, string>
  /** Raw `pnpm-lock.yaml` content. */
  lockfileContent: string
  /** Acknowledged duplicates that suppress the error to a warning. */
  exceptions?: readonly CatalogDuplicateException[]
}

/**
 * Validate that every catalog package resolves to a single version in the
 * lockfile. Returns validation issues for:
 *
 * 1. **Unblessed duplicates** (error): a catalog package with >1 resolved version.
 * 2. **Blessed duplicates** (warning): the same, but covered by an exception.
 * 3. **Stale exceptions** (warning): an exception that no longer matches a duplicate.
 */
export const validateCatalogDuplicates = ({
  catalog,
  lockfileContent,
  exceptions = [],
}: CatalogDuplicatesValidationArgs): GenieValidationIssue[] => {
  const resolved = parseAllResolvedVersionsFromLockfile(lockfileContent)
  const exceptionByPackage = new Map(exceptions.map((e) => [e.package, e]))
  const usedExceptions = new Set<string>()

  const issues: GenieValidationIssue[] = []

  for (const [name, catalogVersion] of Object.entries(catalog)) {
    if (typeof catalogVersion !== 'string') continue
    const versions = resolved.get(name)
    if (versions === undefined || versions.size <= 1) continue

    const sorted = [...versions].sort(byVersionDesc)
    const versionList = sorted.join(', ')
    const baseMessage =
      `"${name}" resolves to ${versions.size} versions in the lockfile: ${versionList} ` +
      `(catalog pins ${catalogVersion}). Run \`pnpm dedupe\` to collapse in-range ` +
      `duplicates, or acknowledge an upstream-locked duplicate via catalogDuplicateExceptions.`

    const exception = exceptionByPackage.get(name)
    if (exception !== undefined) {
      usedExceptions.add(name)
      issues.push({
        severity: 'warning',
        packageName: '(catalog-duplicates)',
        dependency: name,
        message: `${baseMessage} (acknowledged: ${exception.reason}${
          exception.issue !== undefined ? ` — ${exception.issue}` : ''
        })`,
        rule: 'catalog-duplicate-version-acknowledged',
      })
      continue
    }

    issues.push({
      severity: 'error',
      packageName: '(catalog-duplicates)',
      dependency: name,
      message: baseMessage,
      rule: 'catalog-duplicate-version',
    })
  }

  /* Detect stale exceptions */
  for (const { package: name } of exceptions) {
    if (usedExceptions.has(name) === false) {
      issues.push({
        severity: 'warning',
        packageName: '(catalogDuplicateExceptions)',
        dependency: name,
        message: `catalogDuplicateExceptions entry for "${name}" no longer matches a lockfile duplicate — consider removing it`,
        rule: 'catalog-duplicate-stale-exception',
      })
    }
  }

  return issues
}
