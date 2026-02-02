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

/**
 * Derive a pnpm workspace from package.json.genie.ts dependencies.
 *
 * - Includes internal @overeng/* deps from dependencies/devDependencies/peerDependencies.
 * - Converts package names to sibling workspace paths (../<package-name>).
 * - Allows extra packages (examples, non-dependency workspaces) via extraPackages.
 * - Use include to pull transitive workspace deps from related packages.
 */
export const pnpmWorkspaceReactFromPackageJson = (
  pkg: PackageJsonGenie,
  options?: {
    include?: readonly PackageJsonGenie[]
    extraPackages?: readonly string[]
  },
) => {
  const workspacePackages = new Set<string>()
  const allPkgs = [pkg, ...(options?.include ?? [])]

  for (const entry of allPkgs) {
    for (const name of collectInternalPackageNames(entry)) {
      workspacePackages.add(toWorkspacePath(name))
    }
  }

  for (const extra of options?.extraPackages ?? []) {
    workspacePackages.add(extra)
  }

  return pnpmWorkspaceReact([...workspacePackages].toSorted((a, b) => a.localeCompare(b)))
}
