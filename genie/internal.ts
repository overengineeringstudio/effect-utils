/**
 * Internal configuration - effect-utils specific
 *
 * This file contains configuration specific to the effect-utils monorepo.
 * For external/peer repo use, import from `./external.ts` instead.
 */

import { catalog as externalCatalog, defineCatalog, pnpmWorkspaceYaml } from './external.ts'
import { internalPackageCatalogEntries } from './packages.ts'

// Re-export from external for convenience (explicit exports to avoid barrel file)
export {
  baseTsconfigCompilerOptions,
  CatalogBrand,
  createEffectUtilsRefs,
  createPatchPostinstall,
  createPnpmPatchedDependencies,
  defineCatalog,
  definePatchedDependencies,
  domLib,
  effectLspDevDeps,
  effectLspScripts,
  effectUtilsPackages,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  packageJson,
  packageTsconfigCompilerOptions,
  patchPostinstall,
  pnpmPatchedDependencies,
  pnpmWorkspace,
  pnpmWorkspaceYaml,
  privatePackageDefaults,
  reactJsx,
  tsconfigJson,
  workspaceRoot,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type PackageJsonData,
  type PatchesRegistry,
  type PnpmSettings,
  type PnpmWorkspaceData,
  type ScriptValue,
  type TSConfigArgs,
  type TSConfigCompilerOptions,
  type WorkspaceRootData,
} from './external.ts'


/**
 * Extended catalog with internal @overeng/* packages for effect-utils use.
 *
 * Internal packages use `workspace:*` protocol with per-package pnpm-workspace.yaml files.
 * Each package declares its siblings in its workspace, enabling proper symlink resolution.
 *
 * Package list is derived from genie/packages.ts (single source of truth).
 * See: context/workarounds/pnpm-issues.md for full details
 */
export const catalog = defineCatalog({
  extends: externalCatalog,
  packages: internalPackageCatalogEntries,
})

/**
 * Pnpm workspace with React hoisting for single-instance React in dev.
 *
 * Includes supportedArchitectures to download platform-specific binaries for all
 * platforms, making the pnpm store hash consistent across Linux and macOS builds.
 */
export const pnpmWorkspaceReact = (packages: readonly string[]) =>
  pnpmWorkspaceYaml({
    packages: ['.', ...packages],
    publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
    dedupePeerDependents: true,
    supportedArchitectures: {
      os: ['linux', 'darwin'],
      cpu: ['x64', 'arm64'],
    },
  })

type PackageJsonGenie = {
  data: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
}

const internalPackagePrefix = '@overeng/'

const collectInternalPackageNames = (pkg: PackageJsonGenie): string[] => {
  const names = new Set<string>()
  const collect = (deps?: Record<string, string>) => {
    if (!deps) return
    for (const name of Object.keys(deps)) {
      if (name.startsWith(internalPackagePrefix)) {
        names.add(name)
      }
    }
  }

  collect(pkg.data.dependencies)
  collect(pkg.data.devDependencies)
  collect(pkg.data.peerDependencies)

  return [...names]
}

const toWorkspacePath = (packageName: string): string => {
  const name = packageName.split('/')[1]
  return `../${name}`
}

/**
 * Build a registry map from package.json.genie.ts objects.
 */
const buildRegistry = (
  packages: readonly PackageJsonGenie[],
): ReadonlyMap<string, PackageJsonGenie> => {
  const registry = new Map<string, PackageJsonGenie>()
  for (const pkg of packages) {
    const name = (pkg.data as { name?: string }).name
    if (name) {
      registry.set(name, pkg)
    }
  }
  return registry
}

/**
 * Recursively collect all @overeng/* workspace dependencies.
 * Uses BFS to traverse the dependency graph via the provided deps.
 */
const collectWorkspacePackagesRecursive = ({
  pkg,
  registry,
  visited = new Set(),
}: {
  pkg: PackageJsonGenie
  registry: ReadonlyMap<string, PackageJsonGenie>
  visited?: Set<string>
}): Set<string> => {
  const result = new Set<string>()

  const directDeps = collectInternalPackageNames(pkg)
  for (const depName of directDeps) {
    if (visited.has(depName)) continue
    visited.add(depName)

    result.add(toWorkspacePath(depName))

    const depPkg = registry.get(depName)
    if (depPkg) {
      const transitiveDeps = collectWorkspacePackagesRecursive({ pkg: depPkg, registry, visited })
      for (const path of transitiveDeps) {
        result.add(path)
      }
    }
  }

  return result
}

/**
 * Standalone pnpm workspace (no internal deps).
 * Use for packages that don't depend on other @overeng/* packages.
 */
export const pnpmWorkspaceStandalone = () =>
  pnpmWorkspaceYaml({
    packages: ['.'],
    dedupePeerDependents: true,
  })

/**
 * Standalone pnpm workspace with React hoisting (no internal deps).
 * Use for React packages that don't depend on other @overeng/* packages.
 */
export const pnpmWorkspaceStandaloneReact = () =>
  pnpmWorkspaceYaml({
    packages: ['.'],
    publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
    dedupePeerDependents: true,
  })

/**
 * Derive pnpm workspace from package and its imported deps.
 *
 * Each package imports its direct deps' package.json.genie.ts files,
 * and this function recursively resolves transitive deps.
 *
 * @example
 * ```ts
 * import pkg from './package.json.genie.ts'
 * import tuiReactPkg from '../tui-react/package.json.genie.ts'
 * import utilsPkg from '../utils/package.json.genie.ts'
 *
 * export default pnpmWorkspaceWithDeps({ pkg, deps: [tuiReactPkg, utilsPkg] })
 * ```
 */
export const pnpmWorkspaceWithDeps = ({
  pkg,
  deps,
  extraPackages,
}: {
  pkg: PackageJsonGenie
  deps: readonly PackageJsonGenie[]
  /** Extra workspace paths to include (for non-dependency packages like examples) */
  extraPackages?: readonly string[]
}) => {
  const registry = buildRegistry([pkg, ...deps])
  const workspacePaths = new Set<string>()

  // Traverse from main package and all deps to collect transitive workspace dependencies
  for (const p of [pkg, ...deps]) {
    const paths = collectWorkspacePackagesRecursive({ pkg: p, registry })
    for (const path of paths) {
      workspacePaths.add(path)
    }
  }

  for (const extra of extraPackages ?? []) {
    workspacePaths.add(extra)
  }

  const packages = [...workspacePaths].toSorted((a, b) => a.localeCompare(b))
  return pnpmWorkspaceYaml({
    packages: ['.', ...packages],
    dedupePeerDependents: true,
  })
}

/**
 * Derive pnpm workspace with React hoisting from package and its imported deps.
 *
 * @example
 * ```ts
 * import pkg from './package.json.genie.ts'
 * import tuiReactPkg from '../tui-react/package.json.genie.ts'
 * import tuiCorePkg from '../tui-core/package.json.genie.ts'
 *
 * export default pnpmWorkspaceWithDepsReact({ pkg, deps: [tuiReactPkg, tuiCorePkg] })
 * ```
 */
export const pnpmWorkspaceWithDepsReact = ({
  pkg,
  deps,
  extraPackages,
}: {
  pkg: PackageJsonGenie
  deps: readonly PackageJsonGenie[]
  /** Extra workspace paths to include (for non-dependency packages like examples) */
  extraPackages?: readonly string[]
}) => {
  const registry = buildRegistry([pkg, ...deps])
  const workspacePaths = new Set<string>()

  // Traverse from main package and all deps to collect transitive workspace dependencies
  for (const p of [pkg, ...deps]) {
    const paths = collectWorkspacePackagesRecursive({ pkg: p, registry })
    for (const path of paths) {
      workspacePaths.add(path)
    }
  }

  for (const extra of extraPackages ?? []) {
    workspacePaths.add(extra)
  }

  const packages = [...workspacePaths].toSorted((a, b) => a.localeCompare(b))
  return pnpmWorkspaceReact(packages)
}
