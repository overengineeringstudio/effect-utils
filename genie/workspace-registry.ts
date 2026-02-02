/**
 * Central registry of all @overeng/* packages for transitive dependency resolution.
 *
 * Use the pre-configured helpers for simple workspace generation:
 *   import { pnpmWorkspaceReact } from '../../../genie/workspace-registry.ts'
 *   export default pnpmWorkspaceReact(pkg)
 */
import {
  createWorkspaceRegistry,
  pnpmWorkspaceFromPackageJson,
  pnpmWorkspaceReactFromPackageJson,
} from './internal.ts'

// Import all package.json.genie.ts files
import effectPathPkg from '../packages/@overeng/effect-path/package.json.genie.ts'
import effectSchemaFormAriaPkg from '../packages/@overeng/effect-schema-form-aria/package.json.genie.ts'
import effectSchemaFormPkg from '../packages/@overeng/effect-schema-form/package.json.genie.ts'
import geniePkg from '../packages/@overeng/genie/package.json.genie.ts'
import megarepoPlugin from '../packages/@overeng/megarepo/package.json.genie.ts'
import notionEffectClientPkg from '../packages/@overeng/notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../packages/@overeng/notion-effect-schema/package.json.genie.ts'
import notionCliPkg from '../packages/@overeng/notion-cli/package.json.genie.ts'
import tuiCorePkg from '../packages/@overeng/tui-core/package.json.genie.ts'
import tuiReactPkg from '../packages/@overeng/tui-react/package.json.genie.ts'
import utilsPkg from '../packages/@overeng/utils/package.json.genie.ts'

/**
 * Registry of all @overeng/* packages.
 * Used for recursive transitive dependency resolution in pnpm workspaces.
 */
export const workspaceRegistry = createWorkspaceRegistry([
  effectPathPkg,
  effectSchemaFormAriaPkg,
  effectSchemaFormPkg,
  geniePkg,
  megarepoPlugin,
  notionEffectClientPkg,
  notionEffectSchemaPkg,
  notionCliPkg,
  tuiCorePkg,
  tuiReactPkg,
  utilsPkg,
])

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
