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
  definePackageJson,
  effectUtilsWorkspacePatches,
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
  definePackageJson,
  domLib,
  effectUtilsPackages,
  exportEntry,
  githubRuleset,
  githubWorkflow,
  githubWorkflowEvent,
  megarepoJson,
  nodeTypes,
  oxfmtConfig,
  oxlintConfig,
  packageTsconfigCompilerOptions,
  patchPostinstall,
  pnpmPatchedDependencies,
  pnpmWorkspaceYaml,
  privatePackageDefaults,
  reactJsx,
  tsconfigJson,
  type AggregatePackageJsonData,
  type ExportEnvironmentContract,
  type ExportEnvironmentContractCoverage,
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
  type PackageJsonExportEnvironmentContractValidationOptions,
  type PackageJsonInputData,
  type PackageJsonOptions,
  type PackageJsonValidationOptions,
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

export const packageJson = definePackageJson({
  validation: {
    exportEnvironmentContracts: {
      coverage: 'warn',
    },
  },
})

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
 * Common pnpm workspace data for effect-utils workspaces.
 *
 * Extends `commonPnpmPolicySettings` with effect-utils-specific patch metadata
 * and an injection policy for workspace packages.
 *
 * `injectWorkspacePackages: true` with `dedupeInjectedDeps: false` is required
 * for effect-utils' pure Nix/FOD package closure model: every package-local
 * dependency build must hash a physical snapshot of each workspace package it
 * consumes, never dedupe that edge back to a live workspace symlink outside the
 * staged closure.
 *
 * Injection is intentionally NOT part of `commonPnpmPolicySettings` because
 * downstream consumers without a Nix/FOD closure model lose their workspace
 * `devDependencies` / `peerDependencies` at type-check time when injection
 * rewrites the resolution graph (see livestorejs/livestore#1271).
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
  dedupeInjectedDeps: false,
  packageExtensions: {
    ...commonPnpmPolicySettings.packageExtensions,
    // Storybook loads the configured framework preset dynamically from the
    // storybook package, so the dependency edge must be explicit.
    storybook: {
      dependencies: {
        '@storybook/react-vite': '10.4.6',
      },
    },
  },
  patchedDependencies: { ...effectUtilsWorkspacePatches },
  allowUnusedPatches: true as const,
  peerDependencyRules: {
    // Merge the shared rules (e.g. `unplugin: '>=3.0.0'`) with repo-specific
    // entries instead of shadowing them.
    allowedVersions: {
      ...commonPnpmPolicySettings.peerDependencyRules.allowedVersions,
      typescript: '>=6.0.0',
      eslint: '>=10.0.0',
      vitest: '>=4.0.0',
    },
  },
}
