/**
 * Internal configuration - effect-utils specific
 *
 * This file contains configuration specific to the effect-utils monorepo.
 * For external/peer repo use, import from `./external.ts` instead.
 */

import { catalog as externalCatalog, defineCatalog, pnpmWorkspaceYaml } from './external.ts'

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
  packageJson,
  packageTsconfigCompilerOptions,
  patchPostinstall,
  pnpmPatchedDependencies,
  pnpmWorkspace,
  pnpmWorkspaceYaml,
  privatePackageDefaults,
  reactJsx,
  type PatchesRegistry,
  type PnpmSettings,
  type PnpmWorkspaceData,
  type ScriptValue,
  type TSConfigCompilerOptions,
  workspaceRoot,
} from './external.ts'


/**
 * Extended catalog with internal @overeng/* packages for effect-utils use.
 *
 * Internal packages use `workspace:*` protocol with per-package pnpm-workspace.yaml files.
 * Each package declares its siblings in its workspace, enabling proper symlink resolution.
 *
 * See: context/workarounds/pnpm-issues.md for full details
 */
export const catalog = defineCatalog({
  extends: externalCatalog,
  packages: {
    '@overeng/utils': 'workspace:*',
    '@overeng/genie': 'workspace:*',
    '@overeng/megarepo': 'workspace:*',
    '@overeng/effect-path': 'workspace:*',
    '@overeng/notion-effect-schema': 'workspace:*',
    '@overeng/notion-effect-client': 'workspace:*',
    '@overeng/notion-cli': 'workspace:*',
    '@overeng/effect-schema-form': 'workspace:*',
    '@overeng/effect-schema-form-aria': 'workspace:*',
    '@overeng/tui-core': 'workspace:*',
    '@overeng/tui-react': 'workspace:*',
  },
})

/**
 * Pnpm workspace with React hoisting for single-instance React in dev.
 */
export const pnpmWorkspaceReact = (packages: readonly string[]) =>
  pnpmWorkspaceYaml({
    packages: ['.', ...packages],
    publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
    dedupePeerDependents: true,
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

type WorkspaceFromPackageJsonOptions = {
  /**
   * Additional packages to include in workspace resolution.
   * Their @overeng/* dependencies will be collected recursively.
   * @deprecated No longer needed - transitive deps are resolved automatically via registry
   */
  include?: readonly PackageJsonGenie[]
  /** Extra workspace paths to include (for non-dependency packages like examples) */
  extraPackages?: readonly string[]
  /**
   * Registry mapping package names to their genie configs.
   * Used to recursively resolve transitive workspace dependencies.
   * If not provided, only direct dependencies are collected.
   */
  registry?: ReadonlyMap<string, PackageJsonGenie>
}

/**
 * Recursively collect all @overeng/* workspace dependencies.
 * Uses BFS to traverse the dependency graph via the registry.
 */
const collectWorkspacePackagesRecursive = (
  pkg: PackageJsonGenie,
  registry: ReadonlyMap<string, PackageJsonGenie>,
  visited: Set<string> = new Set(),
): Set<string> => {
  const result = new Set<string>()

  const directDeps = collectInternalPackageNames(pkg)
  for (const depName of directDeps) {
    if (visited.has(depName)) continue
    visited.add(depName)

    result.add(toWorkspacePath(depName))

    // Recursively collect transitive deps if in registry
    const depPkg = registry.get(depName)
    if (depPkg) {
      const transitiveDeps = collectWorkspacePackagesRecursive(depPkg, registry, visited)
      for (const path of transitiveDeps) {
        result.add(path)
      }
    }
  }

  return result
}

const collectWorkspacePackages = (
  pkg: PackageJsonGenie,
  options?: WorkspaceFromPackageJsonOptions,
): string[] => {
  const workspacePackages = new Set<string>()

  if (options?.registry) {
    // Use recursive resolution with registry
    const transitiveDeps = collectWorkspacePackagesRecursive(pkg, options.registry)
    for (const path of transitiveDeps) {
      workspacePackages.add(path)
    }
  } else {
    // Fallback: collect from pkg and explicit includes only
    const allPkgs = [pkg, ...(options?.include ?? [])]
    for (const entry of allPkgs) {
      for (const name of collectInternalPackageNames(entry)) {
        workspacePackages.add(toWorkspacePath(name))
      }
    }
  }

  for (const extra of options?.extraPackages ?? []) {
    workspacePackages.add(extra)
  }

  return [...workspacePackages].toSorted((a, b) => a.localeCompare(b))
}

/**
 * Derive a pnpm workspace from package.json.genie.ts dependencies (no React hoisting).
 *
 * - Includes internal @overeng/* deps from dependencies/devDependencies/peerDependencies.
 * - Converts package names to sibling workspace paths (../<package-name>).
 * - Allows extra packages (examples, non-dependency workspaces) via extraPackages.
 * - Use include to pull transitive workspace deps from related packages.
 */
export const pnpmWorkspaceFromPackageJson = (
  pkg: PackageJsonGenie,
  options?: WorkspaceFromPackageJsonOptions,
) => {
  const packages = collectWorkspacePackages(pkg, options)
  return pnpmWorkspaceYaml({
    packages: ['.', ...packages],
    dedupePeerDependents: true,
  })
}

/**
 * Derive a pnpm workspace from package.json.genie.ts dependencies with React hoisting.
 *
 * - Includes internal @overeng/* deps from dependencies/devDependencies/peerDependencies.
 * - Converts package names to sibling workspace paths (../<package-name>).
 * - Allows extra packages (examples, non-dependency workspaces) via extraPackages.
 * - Use registry to automatically resolve transitive workspace deps.
 */
export const pnpmWorkspaceReactFromPackageJson = (
  pkg: PackageJsonGenie,
  options?: WorkspaceFromPackageJsonOptions,
) => {
  const packages = collectWorkspacePackages(pkg, options)
  return pnpmWorkspaceReact(packages)
}

/**
 * Create a registry map from package.json.genie.ts objects.
 * Pass this to pnpmWorkspaceFromPackageJson/pnpmWorkspaceReactFromPackageJson
 * to enable automatic transitive dependency resolution.
 */
export const createWorkspaceRegistry = (
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
