import type { GenieOutput, Strict } from '../mod.ts'
import { stringify } from '../utils/yaml.ts'

/** Configuration for pnpm-workspace.yaml generation */
export interface PnpmWorkspaceConfig {
  /** Workspace package patterns */
  packages: readonly string[]
  /** Catalog of dependency versions */
  catalog: Record<string, string>
  /** Packages that should only be built (not hoisted) */
  onlyBuiltDependencies?: readonly string[]
}

/**
 * Creates a pnpm-workspace.yaml configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * import { catalog, workspacePackages, onlyBuiltDependencies } from './genie/repo.ts'
 * import { pnpmWorkspace } from '@overeng/genie'
 *
 * export default pnpmWorkspace({
 *   packages: workspacePackages,
 *   catalog,
 *   onlyBuiltDependencies,
 * })
 * ```
 */
export const pnpmWorkspace = <const T extends PnpmWorkspaceConfig>(
  config: Strict<T, PnpmWorkspaceConfig>,
): GenieOutput<T> => ({
  data: config,
  stringify: (_ctx) => {
    const { packages, catalog, onlyBuiltDependencies } = config

    const yamlObj: Record<string, unknown> = {
      packages: [...packages],
      catalog: { ...catalog },
    }

    if (onlyBuiltDependencies && onlyBuiltDependencies.length > 0) {
      yamlObj.onlyBuiltDependencies = [...onlyBuiltDependencies]
    }

    return stringify(yamlObj)
  },
})
