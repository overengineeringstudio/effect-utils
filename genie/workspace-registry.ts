/**
 * Central registry of all @overeng/* packages for transitive dependency resolution.
 *
 * Import this registry in pnpm-workspace.yaml.genie.ts files to enable
 * automatic resolution of transitive workspace dependencies.
 */
import { createWorkspaceRegistry } from './internal.ts'

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
