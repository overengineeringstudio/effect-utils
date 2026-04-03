/**
 * Cross-install-root version convergence validation.
 *
 * When multiple pnpm install roots are composed into a single CLI binary
 * via `bun build --compile`, the bundler treats each root's copy of a
 * package as a distinct module. If two roots resolve the same package to
 * different versions, the binary contains duplicate singletons — causing
 * runtime failures like Effect version mismatch warnings, `undefined`
 * spam, and `AsyncFiberException` crashes.
 *
 * This validator reads each install root's `pnpm-lock.yaml` and ensures
 * identity-critical packages resolve to the same version everywhere.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { WorkspacePackageLike } from '../package-json/mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

// =============================================================================
// Lockfile Parser
// =============================================================================

/**
 * Parse the `packages:` section of a pnpm-lock.yaml and extract a map
 * of package name to resolved version.
 *
 * Only returns the first (canonical metadata) entry per package name,
 * skipping resolution-specific entries that contain parentheses.
 */
export const parseResolvedVersionsFromLockfile = (yamlContent: string): Map<string, string> => {
  const result = new Map<string, string>()
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

    /* Package metadata entry: `  'name@version':` or `  name@version:` */
    /* Skip resolution-specific entries containing parentheses */
    const pkgMatch = line.match(/^  '?([^'(]+@[^'(]+?)'?:$/)
    if (pkgMatch !== null) {
      const spec = pkgMatch[1]!
      const atIdx = spec.startsWith('@') === true ? spec.indexOf('@', 1) : spec.indexOf('@')
      if (atIdx > 0) {
        const name = spec.slice(0, atIdx)
        const version = spec.slice(atIdx + 1)
        if (result.has(name) === false) {
          result.set(name, version)
        }
      }
    }
  }

  return result
}

// =============================================================================
// Install Root Discovery
// =============================================================================

type InstallRoot = {
  repoName: string
  lockfilePath: string
}

/**
 * Discover distinct install roots from workspace packages.
 *
 * The root repo's lockfile is at `cwd/pnpm-lock.yaml`.
 * External repos have lockfiles at `cwd/repos/{repoName}/pnpm-lock.yaml`.
 */
const collectRepoNames = ({
  packages,
  visited = new Set(),
}: {
  packages: readonly WorkspacePackageLike[]
  visited?: Set<string>
}): Set<string> => {
  const result = new Set<string>()
  for (const pkg of packages) {
    const key = `${pkg.meta.workspace.repoName}:${pkg.meta.workspace.memberPath}`
    if (visited.has(key) === true) continue
    visited.add(key)
    result.add(pkg.meta.workspace.repoName)
    for (const name of collectRepoNames({ packages: pkg.meta.workspace.deps, visited })) {
      result.add(name)
    }
  }
  return result
}

const discoverInstallRoots = ({
  packages,
  repoName,
  cwd,
}: {
  packages: readonly WorkspacePackageLike[]
  repoName: string
  cwd: string
}): InstallRoot[] => {
  const repoNames = collectRepoNames({ packages })
  repoNames.add(repoName)

  return [...repoNames].map((name) => ({
    repoName: name,
    lockfilePath:
      name === repoName
        ? path.join(cwd, 'pnpm-lock.yaml')
        : path.join(cwd, 'repos', name, 'pnpm-lock.yaml'),
  }))
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Pure version divergence detection — no IO, fully testable.
 *
 * Given a map of (install root name -> resolved versions), checks that
 * each identity-critical package resolves to the same version everywhere.
 */
export const detectVersionDivergence = ({
  versionsByRoot,
  identityCriticalPackages,
}: {
  versionsByRoot: ReadonlyMap<string, ReadonlyMap<string, string>>
  identityCriticalPackages: readonly string[]
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []

  for (const pkgName of identityCriticalPackages) {
    const rootVersions: Array<{ root: string; version: string }> = []

    for (const [root, versions] of versionsByRoot) {
      const version = versions.get(pkgName)
      if (version !== undefined) {
        rootVersions.push({ root, version })
      }
    }

    if (rootVersions.length < 2) continue

    const firstVersion = rootVersions[0]!.version
    const diverging = rootVersions.filter((rv) => rv.version !== firstVersion)

    if (diverging.length > 0) {
      const versionList = rootVersions.map((rv) => `${rv.root} → ${rv.version}`).join(', ')
      issues.push({
        severity: 'error',
        packageName: '(cross-install-root)',
        dependency: pkgName,
        message:
          `"${pkgName}" resolves to different versions across install roots: ${versionList}. ` +
          `This causes module identity duplication when bundled.`,
        rule: 'cross-install-root-version-divergence',
      })
    }
  }

  return issues
}

/** Input for the cross-install-root version convergence validator. */
export type CrossInstallRootValidationArgs = {
  packages: readonly WorkspacePackageLike[]
  repoName: string
  cwd: string
  /** Package names that must resolve to the same version across all install roots. */
  identityCriticalPackages: readonly string[]
}

/**
 * Validate that identity-critical packages resolve to the same version
 * across all install roots in the workspace composition.
 */
export const validateCrossInstallRootVersions = ({
  packages,
  repoName,
  cwd,
  identityCriticalPackages,
}: CrossInstallRootValidationArgs): GenieValidationIssue[] => {
  const installRoots = discoverInstallRoots({ packages, repoName, cwd })

  if (installRoots.length < 2) return []

  const versionsByRoot = new Map<string, Map<string, string>>()

  for (const root of installRoots) {
    try {
      const lockfileContent = readFileSync(root.lockfilePath, 'utf-8')
      versionsByRoot.set(root.repoName, parseResolvedVersionsFromLockfile(lockfileContent))
    } catch {
      /* lockfile not available — skip this root */
    }
  }

  if (versionsByRoot.size < 2) return []

  return detectVersionDivergence({ versionsByRoot, identityCriticalPackages })
}
