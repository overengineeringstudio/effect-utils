/**
 * Internal configuration - effect-utils specific
 *
 * This file contains configuration specific to the effect-utils monorepo.
 * For external/peer repo use, import from `./external.ts` instead.
 */

import {
  catalog as externalCatalog,
  createWorkspaceDepsResolver,
  defineCatalog,
  pnpmWorkspaceYaml,
  type GenieOutput,
  type PackageJsonData,
} from './external.ts'
import { internalPackageCatalogEntries } from './packages.ts'

// Re-export from external for convenience (explicit exports to avoid barrel file)
export {
  baseTsconfigCompilerOptions,
  CatalogBrand,
  computeRelativePath,
  createEffectUtilsRefs,
  createPatchPostinstall,
  createPnpmPatchedDependencies,
  createWorkspaceDepsResolver,
  defineCatalog,
  definePatchedDependencies,
  domLib,
  effectLspDevDeps,
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
  type GenieOutput,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type PackageJsonData,
  type PackageJsonGenie,
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

type PkgInput = GenieOutput<PackageJsonData>

const resolveDeps = createWorkspaceDepsResolver({
  prefixes: ['@overeng/'],
  resolveWorkspacePath: (packageName) => `../${packageName.split('/')[1]}`,
})

/**
 * Standalone pnpm workspace (no internal deps).
 * Use for packages that don't depend on other @overeng/* packages.
 */
export const pnpmWorkspaceStandalone = () =>
  pnpmWorkspaceYaml({
    packages: ['.'],
    dedupePeerDependents: true,
    supportedArchitectures: {
      os: ['linux', 'darwin'],
      cpu: ['x64', 'arm64'],
    },
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
    supportedArchitectures: {
      os: ['linux', 'darwin'],
      cpu: ['x64', 'arm64'],
    },
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
  pkg: PkgInput
  deps: readonly PkgInput[]
  extraPackages?: readonly string[]
}) => {
  const packages = resolveDeps({ pkg, deps, location: '.', extraPackages })
  return pnpmWorkspaceYaml({
    packages: ['.', ...packages],
    dedupePeerDependents: true,
    supportedArchitectures: {
      os: ['linux', 'darwin'],
      cpu: ['x64', 'arm64'],
    },
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
  pkg: PkgInput
  deps: readonly PkgInput[]
  extraPackages?: readonly string[]
}) => {
  const packages = resolveDeps({ pkg, deps, location: '.', extraPackages })
  return pnpmWorkspaceReact(packages)
}
