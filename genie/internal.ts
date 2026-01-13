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
  defineCatalog,
  definePatchedDependencies,
  domLib,
  effectLspDevDeps,
  effectLspScripts,
  effectUtilsPackages,
  packageJson,
  packageTsconfigCompilerOptions,
  patchPostinstall,
  privatePackageDefaults,
  reactJsx,
  type PatchesRegistry,
  type ScriptValue,
  type TSConfigCompilerOptions,
  workspaceRoot,
} from './external.ts'

/**
 * Extended catalog with internal @overeng/* packages for effect-utils use.
 *
 * Internal packages use `file:packages/...` format which gets resolved
 * to relative paths at stringify time based on the consuming package's location.
 */
export const catalog = defineCatalog({
  extends: externalCatalog,
  packages: {
    '@overeng/utils': 'file:packages/@overeng/utils',
    '@overeng/genie': 'file:packages/@overeng/genie',
    '@overeng/mono': 'file:packages/@overeng/mono',
    '@overeng/dotdot': 'file:packages/@overeng/dotdot',
    '@overeng/notion-effect-schema': 'file:packages/@overeng/notion-effect-schema',
    '@overeng/notion-effect-client': 'file:packages/@overeng/notion-effect-client',
    '@overeng/notion-cli': 'file:packages/@overeng/notion-cli',
    '@overeng/effect-schema-form': 'file:packages/@overeng/effect-schema-form',
    '@overeng/effect-schema-form-aria': 'file:packages/@overeng/effect-schema-form-aria',
  },
})
