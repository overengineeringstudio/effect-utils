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
 * - root workspace projection via `pnpmWorkspaceYaml.root(...)`
 * - internal package-closure projection via `projectPnpmPackageClosure(...)`
 *
 * Do not build new public authoring APIs on top of this module.
 */
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

const sortStrings = (values: Iterable<string>) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b))

const collectRootWorkspaceMembersRecursive = ({
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
    const visitedKey = `${pkg.meta.workspace.repoName}:${pkg.meta.workspace.memberPath}`
    if (visited.has(visitedKey) === true) continue
    visited.add(visitedKey)

    if (pkg.meta.workspace.repoName !== currentRepoName) {
      continue
    }

    members.add(pkg.meta.workspace.memberPath)

    for (const dep of collectRootWorkspaceMembersRecursive({
      packages: pkg.meta.workspace.deps,
      currentRepoName,
      visited,
    })) {
      members.add(dep)
    }
  }

  return sortStrings(members)
}

/**
 * Project root workspace member paths from package metadata for an explicit repo view.
 * The caller must specify which repo's perspective to project from — no heuristic inference.
 */
const rootWorkspaceMemberPathsFromPackages = ({
  packages,
  repoName,
}: {
  packages: readonly WorkspacePackageLike[]
  repoName: string
}) =>
  collectRootWorkspaceMembersRecursive({
    packages,
    currentRepoName: repoName,
  })
