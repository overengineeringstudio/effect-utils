/**
 * Internal configuration - effect-utils specific
 *
 * This file contains configuration specific to the effect-utils monorepo.
 * For external/peer repo use, import from `./external.ts` instead.
 */

import { catalog as externalCatalog, defineCatalog } from './external.ts'

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
    '@overeng/mono': 'workspace:*',
    '@overeng/cli-ui': 'workspace:*',
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
