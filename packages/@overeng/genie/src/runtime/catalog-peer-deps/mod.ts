/**
 * Catalog peer dependency validation via pnpm lockfile.
 *
 * Reads peer dependency ranges from `pnpm-lock.yaml` and cross-checks them
 * against catalog versions to detect incompatibilities.
 */

import type { PeerDependencyRules } from '../pnpm-workspace/mod.ts'
import { satisfiesRange } from '../semver/mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

// =============================================================================
// Lockfile Parser
// =============================================================================

/** Resolved peer dependency metadata for a single lockfile package. */
export type PeerDepsEntry = {
  version: string
  peerDependencies: Record<string, string>
}

/** Strip surrounding YAML quotes from a string value. */
const unquote = (s: string): string => {
  const t = s.trim()
  if (
    (t.startsWith("'") === true && t.endsWith("'") === true) ||
    (t.startsWith('"') === true && t.endsWith('"') === true)
  )
    return t.slice(1, -1)
  return t
}

/**
 * Parse the `packages:` section of a pnpm-lock.yaml file and extract
 * peer dependency metadata for each package.
 *
 * Only returns the first (canonical metadata) entry per package name,
 * ignoring resolution-specific duplicate entries.
 */
export const parsePeerDepsFromLockfile = (yamlContent: string): Map<string, PeerDepsEntry> => {
  const result = new Map<string, PeerDepsEntry>()
  const lines = yamlContent.split('\n')

  let inPackages = false
  let currentPkg: string | undefined
  let currentVersion: string | undefined
  let inPeerDeps = false
  let peerDeps: Record<string, string> = {}

  const flush = () => {
    if (
      currentPkg !== undefined &&
      currentVersion !== undefined &&
      Object.keys(peerDeps).length > 0
    ) {
      if (result.has(currentPkg) === false) {
        result.set(currentPkg, { version: currentVersion, peerDependencies: { ...peerDeps } })
      }
    }
    peerDeps = {}
    inPeerDeps = false
  }

  for (const line of lines) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }
    if (inPackages === false) continue

    /* New top-level section ends the packages block */
    if (/^\S/.test(line) === true && line !== 'packages:') {
      flush()
      inPackages = false
      continue
    }

    /* Package metadata entry: `  'name@version':` or `  'name@version(...)':` */
    const pkgMatch = line.match(/^  '([^']+@[^'(]+)':$/)
    if (pkgMatch !== null) {
      flush()
      const spec = pkgMatch[1]!
      const atIdx = spec.startsWith('@') === true ? spec.indexOf('@', 1) : spec.indexOf('@')
      if (atIdx > 0) {
        currentPkg = spec.slice(0, atIdx)
        currentVersion = spec.slice(atIdx + 1)
      }
      inPeerDeps = false
      continue
    }

    if (line === '    peerDependencies:') {
      inPeerDeps = true
      continue
    }

    /* Any other 4-space key exits the peerDependencies block */
    if (/^    \S/.test(line) === true && line !== '    peerDependencies:') {
      inPeerDeps = false
      continue
    }

    if (inPeerDeps) {
      const m = line.match(/^      (.+?):\s+(.+)$/)
      if (m !== null) {
        peerDeps[unquote(m[1]!)] = unquote(m[2]!)
      }
    }
  }

  flush()
  return result
}

// =============================================================================
// Validation
// =============================================================================

/** Input for `validateCatalogPeerDeps`: catalog versions, lockfile content, and optional override rules. */
export type CatalogPeerDepsValidationArgs = {
  /** Catalog entries: package name → version */
  catalog: Record<string, string>
  /** Raw pnpm-lock.yaml content */
  lockfileContent: string
  /** Optional peer dependency override rules from pnpm workspace config */
  peerDependencyRules?: PeerDependencyRules
}

/**
 * Validate that all catalog packages' peer dependency ranges are satisfied
 * by other catalog entries. Returns validation issues for:
 *
 * 1. **Peer conflicts**: a catalog package's peer dep range doesn't cover our catalog version
 * 2. **Stale overrides**: a `peerDependencyRules.allowedVersions` entry that doesn't suppress any conflict
 *
 * Conflicts covered by `peerDependencyRules.allowedVersions` are reported as warnings, not errors.
 */
export const validateCatalogPeerDeps = ({
  catalog,
  lockfileContent,
  peerDependencyRules,
}: CatalogPeerDepsValidationArgs): GenieValidationIssue[] => {
  const catalogEntries = Object.entries(catalog).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  const catalogMap = new Map(catalogEntries)
  const peerDepsMap = parsePeerDepsFromLockfile(lockfileContent)
  const allowedVersions = peerDependencyRules?.allowedVersions ?? {}

  const issues: GenieValidationIssue[] = []
  /** Track which allowedVersions keys are actually used to suppress a conflict */
  const usedOverrides = new Set<string>()

  for (const [name, version] of catalogEntries) {
    const lockEntry = peerDepsMap.get(name)
    if (lockEntry === undefined) continue
    if (lockEntry.version !== version) continue

    for (const [peerName, peerRange] of Object.entries(lockEntry.peerDependencies)) {
      const catalogVersion = catalogMap.get(peerName)
      if (catalogVersion === undefined) continue
      if (satisfiesRange(catalogVersion, peerRange) === true) continue

      /* Conflict found — check if suppressed by peerDependencyRules */
      const overrideRange = allowedVersions[peerName]
      if (overrideRange !== undefined && satisfiesRange(catalogVersion, overrideRange) === true) {
        usedOverrides.add(peerName)
        issues.push({
          severity: 'warning',
          packageName: name,
          dependency: peerName,
          message:
            `${name}@${version} peers on ${peerName}: ${peerRange}, ` +
            `but catalog has ${catalogVersion} (suppressed by peerDependencyRules)`,
          rule: 'catalog-peer-dep-conflict-suppressed',
        })
        continue
      }

      issues.push({
        severity: 'error',
        packageName: name,
        dependency: peerName,
        message:
          `${name}@${version} peers on ${peerName}: ${peerRange}, ` +
          `but catalog has ${catalogVersion}`,
        rule: 'catalog-peer-dep-conflict',
      })
    }
  }

  /* Detect stale peerDependencyRules entries */
  for (const overridePeer of Object.keys(allowedVersions)) {
    if (usedOverrides.has(overridePeer) === false) {
      issues.push({
        severity: 'warning',
        packageName: '(peerDependencyRules)',
        dependency: overridePeer,
        message: `peerDependencyRules.allowedVersions entry for "${overridePeer}" does not suppress any catalog conflict — consider removing it`,
        rule: 'catalog-peer-dep-stale-override',
      })
    }
  }

  return issues
}
