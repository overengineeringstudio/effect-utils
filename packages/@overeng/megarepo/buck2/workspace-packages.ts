/* oxlint-disable overeng/exports-first -- Exports are derived only after the private canonical registries and reachability walk are initialized. */
import { posix } from 'node:path'

import { rootWorkspaceTsconfigProjects } from '../../../../genie/tsconfig-projects.ts'
import { rootWorkspacePackages } from '../../../../package.json.genie.ts'

const tsconfigByPath = new Map(
  rootWorkspaceTsconfigProjects.map(({ path, tsconfig }) => [path, tsconfig] as const),
)
const allWorkspacePackages = Object.fromEntries(
  rootWorkspacePackages.map((packageJson) => {
    const memberPath = packageJson.meta.workspace.memberPath
    const tsconfig = tsconfigByPath.get(memberPath)
    if (tsconfig === undefined) throw new Error(`Missing workspace tsconfig for ${memberPath}`)
    return [packageJson.data.name, { memberPath, packageJson, tsconfig }] as const
  }),
)
const packageNameByPath = new Map(
  Object.entries(allWorkspacePackages).map(([name, { memberPath }]) => [memberPath, name]),
)
const megarepoName = '@overeng/megarepo'
const pending = [megarepoName]
const reachable = new Set<string>()
while (pending.length > 0) {
  const name = pending.pop()!
  if (reachable.has(name) === true) continue
  const entry = allWorkspacePackages[name]
  if (entry === undefined) throw new Error(`Unknown workspace package: ${name}`)
  reachable.add(name)
  for (const dependency of Object.keys(entry.packageJson.data.dependencies ?? {})) {
    if (dependency in allWorkspacePackages) pending.push(dependency)
    else if (dependency.startsWith('@overeng/') === true)
      throw new Error(`Unknown first-party workspace dependency: ${dependency}`)
  }
  for (const reference of entry.tsconfig.data.references ?? []) {
    const path = posix.normalize(posix.join(entry.memberPath, reference.path))
    const dependency = packageNameByPath.get(path)
    if (dependency === undefined) throw new Error(`Unknown workspace tsconfig reference: ${path}`)
    pending.push(dependency)
  }
}

/** Canonical package and tsconfig facets reachable from the mr product or quality graph. */
export const workspacePackages = Object.fromEntries(
  [...reachable]
    .filter((name) => name !== megarepoName)
    .map((name) => [name, allWorkspacePackages[name]] as const),
)

/** Resolve a dependency specifier against the canonical workspace registry. */
export const workspaceName = (specifier: string): string | undefined =>
  specifier in workspacePackages ? specifier : undefined

/** Map a reachable workspace package and role to its Buck label and staging path. */
export const workspaceBuckBinding = ({
  name,
  role,
}: {
  name: string
  role: 'production' | 'project'
}) => {
  const entry = workspacePackages[name]
  if (entry === undefined) throw new Error(`Unknown reachable workspace package: ${name}`)
  const prefix = 'packages/@overeng/'
  if (entry.memberPath.startsWith(prefix) === false)
    throw new Error(`Reachable package has no Buck projection: ${entry.memberPath}`)
  const targetName = entry.memberPath.slice(prefix.length)
  const packagePath = targetName === 'tui-core' ? `${prefix}tui-core` : prefix.slice(0, -1)
  const label =
    targetName === 'tui-core'
      ? `//packages/@overeng/tui-core:${role}_sources`
      : `//packages/@overeng:${targetName}_${role}_sources`
  return { label, packagePath, targetName }
}
