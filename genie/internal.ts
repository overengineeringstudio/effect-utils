/**
 * Internal configuration - effect-utils specific
 *
 * This file contains configuration specific to the effect-utils monorepo.
 * For external/peer repo use, import from `./external.ts` instead.
 */

import {
  catalog as externalCatalog,
  commonPnpmPolicySettings,
  defineCatalog,
  effectUtilsWorkspacePatches,
  utilsPatches,
} from './external.ts'
import { internalPackageCatalogEntries } from './packages.ts'

export {
  baseTsconfigCompilerOptions,
  commonPnpmPolicySettings,
  createEffectUtilsRefs,
  createPatchPostinstall,
  createPnpmPatchedDependencies,
  defineCatalog,
  definePatchedDependencies,
  domLib,
  effectUtilsPackages,
  exportEntry,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  nodeTypes,
  oxfmtConfig,
  oxlintConfig,
  packageJson,
  packageTsconfigCompilerOptions,
  patchPostinstall,
  pnpmPatchedDependencies,
  pnpmWorkspaceYaml,
  privatePackageDefaults,
  reactJsx,
  tsconfigJson,
  type AggregatePackageJsonData,
  type ExportEnvironmentContract,
  type ExportEnvironmentContracts,
  type ExportEnvironmentName,
  type ExportTypeProofMode,
  type GenieOutput,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type PackageJsonData,
  type PackageJsonInputData,
  type PatchesRegistry,
  type PnpmPackageClosureConfig,
  type PnpmSettings,
  type PnpmWorkspaceData,
  type ScriptValue,
  type TSConfigArgs,
  type TSConfigCompilerOptions,
  type WorkspaceIdentity,
  type WorkspaceMeta,
  type WorkspaceMetadata,
  type WorkspacePackage,
  type WorkspacePackageLike,
} from './external.ts'

/**
 * Extended catalog with internal @overeng/* packages for effect-utils use.
 *
 * Internal packages use `workspace:*` inside the standalone repo topology.
 * Cross-repo composition uses generated aggregate roots instead.
 *
 * Package list is derived from genie/packages.ts (single source of truth).
 * See: context/workarounds/pnpm-issues.md for full details
 */
export const catalog = defineCatalog({
  extends: externalCatalog,
  packages: internalPackageCatalogEntries,
})

const WORKSPACE_REPO_NAME = 'effect-utils'

/** Creates a workspace member descriptor for a package path within the effect-utils repo */
export const workspaceMember = ({
  memberPath,
  pnpmPackageClosure = {},
}: {
  memberPath: string
  pnpmPackageClosure?: PnpmPackageClosureConfig
}) =>
  ({
    repoName: WORKSPACE_REPO_NAME,
    memberPath,
    pnpmPackageClosure,
  }) as const

/**
 * Patched dependencies for `@overeng/utils`.
 * Re-exported from `external.ts` (single source of truth) so downstream
 * projections via `createPnpmPatchedDependencies` and internal workspaces
 * cannot drift.
 */
export { utilsPatches }

/**
 * Common pnpm workspace data for effect-utils workspaces.
 *
 * Extends `commonPnpmPolicySettings` with effect-utils-specific patch metadata
 * and `injectWorkspacePackages: true`.
 *
 * `injectWorkspacePackages: true` is required for effect-utils' pure Nix/FOD
 * package closure model: a package-local dependency build must hash every
 * workspace package it consumes as dependency input, not accidentally reach
 * outside the staged closure through a live symlink. It is intentionally
 * NOT part of `commonPnpmPolicySettings` because downstream consumers without
 * a Nix/FOD closure model lose their workspace `devDependencies` /
 * `peerDependencies` at type-check time when injection rewrites the
 * resolution graph (see livestorejs/livestore#1271).
 *
 * All effect-utils workspaces share the same `patchedDependencies` and `allowUnusedPatches`
 * so that internal package-closure projections and the aggregate root stay on
 * the same patch metadata.
 *
 * NOTE: `sharedWorkspaceLockfile: false` is intentionally NOT set here.
 * Build-time package closures do not own lockfiles, and reintroducing per-member
 * lock ownership would cause TS2742 errors in `tsc --build` because each
 * workspace member gets its own `.pnpm` store, creating different physical
 * paths for the same package. TypeScript treats these as distinct types,
 * breaking project references.
 */
export const commonPnpmWorkspaceData = {
  ...commonPnpmPolicySettings,
  injectWorkspacePackages: true as const,
  packageExtensions: {
    ...commonPnpmPolicySettings.packageExtensions,
    // Storybook loads the configured framework preset dynamically from the
    // storybook package. Under pnpm's global virtual store, that import cannot
    // see the workspace package's dev dependency unless the edge is explicit.
    storybook: {
      dependencies: {
        '@storybook/react-vite': '10.4.6',
      },
    },
  },
  patchedDependencies: { ...effectUtilsWorkspacePatches },
  allowUnusedPatches: true as const,
  peerDependencyRules: {
    /** @effect-atom/atom@0.5.3 pins pre-1.0 Effect peer ranges that don't cover our versions */
    allowedVersions: {
      '@effect/experimental': '>=0.58.0',
      '@effect/platform': '>=0.94.2',
      '@effect/rpc': '>=0.73.0',
      eslint: '>=10.0.0',
      typescript: '>=6.0.0',
      vitest: '>=4.0.0',
    },
  },
}
