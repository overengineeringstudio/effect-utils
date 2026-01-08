import { stringify } from './yaml.ts'

export interface PnpmWorkspaceConfig {
  /** Workspace package patterns */
  packages: readonly string[]
  /** Catalog of dependency versions */
  catalog: Record<string, string>
  /** Packages that should only be built (not hoisted) */
  onlyBuiltDependencies?: readonly string[]
}

/**
 * Generate a pnpm-workspace.yaml file content
 *
 * @example
 * ```ts
 * import { catalog, workspacePackages, onlyBuiltDependencies } from './genie/repo.ts'
 * import { pnpmWorkspace } from '@overeng/genie/lib/pnpm-workspace'
 *
 * export default pnpmWorkspace({
 *   packages: workspacePackages,
 *   catalog,
 *   onlyBuiltDependencies,
 * })
 * ```
 */
export const pnpmWorkspace = (config: PnpmWorkspaceConfig): string => {
  const { packages, catalog, onlyBuiltDependencies } = config

  const yamlObj: Record<string, unknown> = {
    packages: [...packages],
    catalog: { ...catalog },
  }

  if (onlyBuiltDependencies && onlyBuiltDependencies.length > 0) {
    yamlObj.onlyBuiltDependencies = [...onlyBuiltDependencies]
  }

  return stringify(yamlObj)
}
