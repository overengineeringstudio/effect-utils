/**
 * Central registry of all @overeng/* packages for transitive dependency resolution.
 *
 * Use the pre-configured helpers for simple workspace generation:
 *   import { pnpmWorkspaceReact } from '../../../genie/workspace-registry.ts'
 *   export default pnpmWorkspaceReact(pkg)
 *
 * When adding a new package, update genie/packages.ts (single source of truth)
 * and add the corresponding import below.
 */
import {
  createWorkspaceRegistry,
  pnpmWorkspaceFromPackageJson,
  pnpmWorkspaceReactFromPackageJson,
} from './internal.ts'
import { internalPackages } from './packages.ts'

// Import all package.json.genie.ts files (must match genie/packages.ts)
import effectPathPkg from '../packages/@overeng/effect-path/package.json.genie.ts'
import effectSchemaFormPkg from '../packages/@overeng/effect-schema-form/package.json.genie.ts'
import effectSchemaFormAriaPkg from '../packages/@overeng/effect-schema-form-aria/package.json.genie.ts'
import geniePkg from '../packages/@overeng/genie/package.json.genie.ts'
import megarepoPlugin from '../packages/@overeng/megarepo/package.json.genie.ts'
import notionCliPkg from '../packages/@overeng/notion-cli/package.json.genie.ts'
import notionEffectClientPkg from '../packages/@overeng/notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../packages/@overeng/notion-effect-schema/package.json.genie.ts'
import tuiCorePkg from '../packages/@overeng/tui-core/package.json.genie.ts'
import tuiReactPkg from '../packages/@overeng/tui-react/package.json.genie.ts'
import utilsPkg from '../packages/@overeng/utils/package.json.genie.ts'

/**
 * Map of package short names to their genie configs.
 * Order matches genie/packages.ts for easy verification.
 */
const packageConfigs = {
  'effect-path': effectPathPkg,
  'effect-schema-form': effectSchemaFormPkg,
  'effect-schema-form-aria': effectSchemaFormAriaPkg,
  'genie': geniePkg,
  'megarepo': megarepoPlugin,
  'notion-cli': notionCliPkg,
  'notion-effect-client': notionEffectClientPkg,
  'notion-effect-schema': notionEffectSchemaPkg,
  'tui-core': tuiCorePkg,
  'tui-react': tuiReactPkg,
  'utils': utilsPkg,
} as const

// Validate that packageConfigs matches internalPackages at build time
const registeredPackages = Object.keys(packageConfigs).sort()
const expectedPackages = [...internalPackages].sort()
if (registeredPackages.join(',') !== expectedPackages.join(',')) {
  throw new Error(
    `workspace-registry.ts is out of sync with genie/packages.ts.\n` +
      `Expected: ${expectedPackages.join(', ')}\n` +
      `Got: ${registeredPackages.join(', ')}`,
  )
}

/**
 * Registry of all @overeng/* packages.
 * Used for recursive transitive dependency resolution in pnpm workspaces.
 */
export const workspaceRegistry = createWorkspaceRegistry(Object.values(packageConfigs))

type PackageJsonGenie = Parameters<typeof pnpmWorkspaceFromPackageJson>[0]
type ExtraOptions = { extraPackages?: readonly string[] }

/**
 * Pre-configured workspace helper with React hoisting.
 * Automatically uses the workspace registry for transitive dependency resolution.
 */
export const pnpmWorkspaceReact = (pkg: PackageJsonGenie, options?: ExtraOptions) =>
  pnpmWorkspaceReactFromPackageJson(pkg, { ...options, registry: workspaceRegistry })

/**
 * Pre-configured workspace helper without React hoisting.
 * Automatically uses the workspace registry for transitive dependency resolution.
 */
export const pnpmWorkspace = (pkg: PackageJsonGenie, options?: ExtraOptions) =>
  pnpmWorkspaceFromPackageJson(pkg, { ...options, registry: workspaceRegistry })
