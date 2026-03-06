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
  definePatchedDependencies,
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
 * Patched dependencies for `@overeng/utils`.
 * Shared across workspace yamls that include utils as a workspace member.
 */
export const utilsPatches = definePatchedDependencies({
  location: 'packages/@overeng/utils',
  patches: {
    'effect-distributed-lock@0.0.11': './patches/effect-distributed-lock@0.0.11.patch',
  },
})

/**
 * Common pnpm workspace settings for all effect-utils packages.
 *
 * All workspaces share the same `patchedDependencies` and `allowUnusedPatches`
 * so that lockfiles remain consistent when the same package appears in multiple workspaces.
 *
 * NOTE: `sharedWorkspaceLockfile: false` is intentionally NOT set here.
 * Per-member lockfiles cause TS2742 errors in `tsc --build` because each workspace member
 * gets its own `.pnpm` store, creating different physical paths for the same package.
 * TypeScript treats these as distinct types, breaking project references.
 */
const commonWorkspaceSettings = {
  patchedDependencies: utilsPatches,
  allowUnusedPatches: true as const,
  dedupePeerDependents: true as const,
  supportedArchitectures: {
    os: ['linux', 'darwin'],
    cpu: ['x64', 'arm64'],
  },
}

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
    ...commonWorkspaceSettings,
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
    ...commonWorkspaceSettings,
  })

/**
 * Standalone pnpm workspace with React hoisting (no internal deps).
 * Use for React packages that don't depend on other @overeng/* packages.
 */
export const pnpmWorkspaceStandaloneReact = () =>
  pnpmWorkspaceYaml({
    packages: ['.'],
    publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
    ...commonWorkspaceSettings,
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
    ...commonWorkspaceSettings,
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

type DirectDependencySource = Pick<
  PackageJsonData,
  'name' | 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
>

/**
 * Dependency family that acts as part of the internal type/runtime ABI for
 * source-imported React/Effect workspaces.
 */
export const sourceTypedReactEffectFamily = [
  '@effect-atom/atom',
  '@effect-atom/atom-react',
  'effect',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  'react',
  'react-dom',
  'react-reconciler',
  '@opentui/core',
  '@opentui/react',
  '@types/react',
  '@types/react-reconciler',
] as const

const resolveDirectDependencyVersion = ({
  source,
  dependencyName,
}: {
  source: DirectDependencySource
  dependencyName: string
}) => {
  const version =
    source.dependencies?.[dependencyName] ??
    source.devDependencies?.[dependencyName] ??
    source.optionalDependencies?.[dependencyName]

  if (version !== undefined) {
    return version
  }

  throw new Error(
    [
      `Cannot align "${dependencyName}" from ${source.name ?? '<unknown package>'}.`,
      'The dependency is exposed as a peer but is not pinned in dependencies, devDependencies, or optionalDependencies.',
    ].join(' '),
  )
}

/**
 * Return exact install-time overrides for an explicitly named dependency family.
 *
 * Only dependency names that are:
 * - listed in `dependencyNames`
 * - present in `dependencies`
 * - exposed as peer dependencies by at least one listed source
 *
 * are aligned to the upstream source package's exact direct pin.
 */
export const alignInstallDependencyFamily = ({
  dependencies,
  dependencyNames,
  sources,
}: {
  dependencies: Record<string, string>
  dependencyNames: readonly string[]
  sources: readonly DirectDependencySource[]
}) => {
  const overrides = new Map<string, string>()

  for (const dependencyName of dependencyNames) {
    if (dependencies[dependencyName] === undefined) {
      continue
    }

    for (const source of sources) {
      if (source.peerDependencies?.[dependencyName] === undefined) {
        continue
      }

      const version = resolveDirectDependencyVersion({ source, dependencyName })
      const existingVersion = overrides.get(dependencyName)

      if (existingVersion !== undefined && existingVersion !== version) {
        throw new Error(
          [
            `Cannot align "${dependencyName}".`,
            `Conflicting source versions detected: ${existingVersion} vs ${version}.`,
          ].join(' '),
        )
      }

      overrides.set(dependencyName, version)
    }
  }

  return Object.fromEntries(overrides)
}
