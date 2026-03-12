/**
 * Internal workspace-graph adapter.
 *
 * This module derives normalized workspace graph metadata from package-local
 * metadata plus real filesystem layout. It is intentionally not part of the
 * author-facing Genie API.
 *
 * The current implementation still relies on path/realpath-based repo identity
 * and `.git` walking. That is acceptable as a projection adapter for the
 * composed-root model, but it is transitional. Package authoring should go
 * through:
 *
 * - `catalog.compose(...)`
 * - `packageJson(data, composition)`
 * - projection wrappers such as `pnpmWorkspaceYaml.package(...)`
 *   and `pnpmWorkspaceYaml.root(...)`
 *
 * Do not build new public authoring APIs on top of this module.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { WorkspacePackageLike } from './package-json/mod.ts'

const normalizeLogicalPath = (value: string) => {
  const normalized = value.split(path.sep).join(path.posix.sep)
  return normalized === '' ? '.' : normalized
}

/** Compute a relative repo path from one logical workspace location to another. */
export const relativeRepoPath = ({ from, to }: { from: string; to: string }) => {
  const normalizedFrom = from === '.' ? '' : from
  const fromParts = normalizedFrom.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const relativePath = '../'.repeat(upCount) + downPath

  return relativePath === '' ? '.' : relativePath
}

const findRepoRootFromDir = (dir: string) => {
  let current = fs.realpathSync(path.resolve(dir))

  while (true) {
    if (fs.existsSync(path.join(current, '.git')) === true) return current

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`Could not determine repo root for workspace metadata from: ${dir}`)
    }
    current = parent
  }
}

const repoNameFromRepoRoot = (repoRoot: string) => {
  const parts = normalizeLogicalPath(repoRoot).split('/')
  const refsIndex = parts.lastIndexOf('refs')
  if (refsIndex > 0) return parts[refsIndex - 1]!
  return path.basename(repoRoot)
}

const logicalWorkspaceMemberPath = ({
  currentRepoName,
  pkg,
}: {
  currentRepoName: string
  pkg: WorkspacePackageLike
}) =>
  pkg.meta.workspace.repoName === currentRepoName
    ? pkg.meta.workspace.memberPath
    : path.posix.join('repos', pkg.meta.workspace.repoName, pkg.meta.workspace.memberPath)

const sortStrings = (values: Iterable<string>) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b))

const collectWorkspaceMembersRecursive = ({
  packages,
  currentRepoName,
  visited = new Set<string>(),
}: {
  packages: readonly WorkspacePackageLike[]
  currentRepoName: string
  visited?: Set<string>
}): string[] => {
  const members = new Set<string>()

  for (const pkg of packages) {
    const visitedKey =
      pkg.data.name ?? `${pkg.meta.workspace.repoName}:${pkg.meta.workspace.memberPath}`
    if (visited.has(visitedKey) === true) continue
    visited.add(visitedKey)

    members.add(logicalWorkspaceMemberPath({ currentRepoName, pkg }))

    for (const dep of collectWorkspaceMembersRecursive({
      packages: pkg.meta.workspace.deps,
      currentRepoName,
      visited,
    })) {
      members.add(dep)
    }
  }

  return sortStrings(members)
}

/** Project root workspace member paths from package metadata for the current repo view. */
export const rootWorkspaceMemberPathsFromPackages = ({
  dir,
  packages,
  extraPackages = [],
}: {
  dir: string
  packages: readonly WorkspacePackageLike[]
  extraPackages?: readonly string[]
}) =>
  sortStrings([
    ...collectWorkspaceMembersRecursive({
      packages,
      currentRepoName: repoNameFromRepoRoot(findRepoRootFromDir(dir)),
    }),
    ...extraPackages,
  ])
