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
  definePatchedDependencies,
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
  githubRuleset,
  githubWorkflow,
  megarepoJson,
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
  type GenieOutput,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type PackageJsonData,
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
export const workspaceMember = (
  memberPath: string,
  pnpmPackageClosure: PnpmPackageClosureConfig = {},
) =>
  ({
    repoName: WORKSPACE_REPO_NAME,
    memberPath,
    pnpmPackageClosure,
  }) as const

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
 * Common pnpm workspace data for effect-utils workspaces.
 *
 * Extends `commonPnpmPolicySettings` with effect-utils-specific patch metadata.
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
  patchedDependencies: utilsPatches,
  allowUnusedPatches: true as const,
  peerDependencyRules: {
    allowedVersions: {
      /** @xterm/addon-canvas 0.7.0 declares ^5.0.0 but works fine with 6.0.0 */
      '@xterm/addon-canvas>@xterm/xterm': '6.0.0',
    },
  },
}
