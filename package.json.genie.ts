import { packageJson } from './genie/internal.ts'
import effectAiClaudeCliPkg from './packages/@overeng/effect-ai-claude-cli/package.json.genie.ts'
import effectPathPkg from './packages/@overeng/effect-path/package.json.genie.ts'
import effectReactPkg from './packages/@overeng/effect-react/package.json.genie.ts'
import effectRpcTanstackBasicPkg from './packages/@overeng/effect-rpc-tanstack/examples/basic/package.json.genie.ts'
import effectRpcTanstackPkg from './packages/@overeng/effect-rpc-tanstack/package.json.genie.ts'
import effectSchemaFormAriaPkg from './packages/@overeng/effect-schema-form-aria/package.json.genie.ts'
import effectSchemaFormPkg from './packages/@overeng/effect-schema-form/package.json.genie.ts'
import geniePkg from './packages/@overeng/genie/package.json.genie.ts'
import megarepoPkg from './packages/@overeng/megarepo/package.json.genie.ts'
import notionCliPkg from './packages/@overeng/notion-cli/package.json.genie.ts'
import notionEffectClientPkg from './packages/@overeng/notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from './packages/@overeng/notion-effect-schema/package.json.genie.ts'
import oxcConfigPkg from './packages/@overeng/oxc-config/package.json.genie.ts'
import reactInspectorPkg from './packages/@overeng/react-inspector/package.json.genie.ts'
import tuiCorePkg from './packages/@overeng/tui-core/package.json.genie.ts'
import tuiReactPkg from './packages/@overeng/tui-react/package.json.genie.ts'
import utilsDevPkg from './packages/@overeng/utils-dev/package.json.genie.ts'
import utilsPkg from './packages/@overeng/utils/package.json.genie.ts'

export const rootWorkspacePackages = [
  effectAiClaudeCliPkg,
  effectPathPkg,
  effectReactPkg,
  effectRpcTanstackBasicPkg,
  effectRpcTanstackPkg,
  effectSchemaFormAriaPkg,
  effectSchemaFormPkg,
  geniePkg,
  megarepoPkg,
  notionCliPkg,
  notionEffectClientPkg,
  notionEffectSchemaPkg,
  oxcConfigPkg,
  reactInspectorPkg,
  tuiCorePkg,
  tuiReactPkg,
  utilsPkg,
  utilsDevPkg,
] as const

export const rootWorkspaceExtraMembers = ['context/effect/socket', 'context/opentui'] as const

const rootWorkspace = packageJson.aggregateFromPackages({
  packages: rootWorkspacePackages,
  extraWorkspaces: rootWorkspaceExtraMembers,
  name: 'effect-utils-workspace',
})

export const rootWorkspaceMemberPaths = rootWorkspace.data.workspaces

export default rootWorkspace
