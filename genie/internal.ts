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
  privatePackageDefaults,
  reactJsx,
  reactTypesPathWorkaround,
  type PatchesRegistry,
  type ScriptValue,
  type TSConfigCompilerOptions,
  workspaceRoot,
} from './external.ts'

/**
 * Extended catalog with internal @overeng/* packages for effect-utils use.
 *
 * Internal packages use `link:packages/...` format which gets resolved
 * to relative paths at stringify time based on the consuming package's location.
 *
 * Why `link:` instead of `file:`?
 * - `link:` creates a symlink to the source directory, so the package uses its OWN node_modules
 * - `file:` copies the package, and deps are resolved from the CONSUMER's context
 * - `link:` matches how published packages behave (each has its own dependency tree)
 * - This avoids TypeScript TS2742 "type portability" errors across package boundaries
 *
 * See: context/workarounds/pnpm-issues.md for full details
 */
export const catalog = defineCatalog({
  extends: externalCatalog,
  packages: {
    '@overeng/utils': 'link:packages/@overeng/utils',
    '@overeng/genie': 'link:packages/@overeng/genie',
    '@overeng/mono': 'link:packages/@overeng/mono',
    '@overeng/cli-ui': 'link:packages/@overeng/cli-ui',
    '@overeng/dotdot': 'link:packages/@overeng/dotdot',
    '@overeng/megarepo': 'link:packages/@overeng/megarepo',
    '@overeng/effect-path': 'link:packages/@overeng/effect-path',
    '@overeng/notion-effect-schema': 'link:packages/@overeng/notion-effect-schema',
    '@overeng/notion-effect-client': 'link:packages/@overeng/notion-effect-client',
    '@overeng/notion-cli': 'link:packages/@overeng/notion-cli',
    '@overeng/effect-schema-form': 'link:packages/@overeng/effect-schema-form',
    '@overeng/effect-schema-form-aria': 'link:packages/@overeng/effect-schema-form-aria',
  },
})
