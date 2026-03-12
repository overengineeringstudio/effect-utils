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
import path from 'node:path'

import type { WorkspacePackageLike } from './package-json/mod.ts'

export { relativeRepoPath, rootWorkspaceMemberPathsFromPackages }

/** Compute a relative repo path from one logical workspace location to another. */
const relativeRepoPath = ({ from, to }: { from: string; to: string }) => {
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

const inferCurrentRepoNameFromPackages = (packages: readonly WorkspacePackageLike[]) => {
  const repoNames = new Set(packages.map((pkg) => pkg.meta.workspace.repoName))
  const [repoName] = Array.from(repoNames)

  if (repoName === undefined) {
    throw new Error('Cannot infer a root workspace repo without any packages')
  }

  return repoName
}

/** Project root workspace member paths from package metadata for the current repo view. */
const rootWorkspaceMemberPathsFromPackages = ({
  packages,
}: {
  packages: readonly WorkspacePackageLike[]
}) =>
  packages.length === 0
    ? []
    : collectWorkspaceMembersRecursive({
        packages,
        currentRepoName: inferCurrentRepoNameFromPackages(packages),
      })
