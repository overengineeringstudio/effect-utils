import { workspaceMemberPathsFromPackages, workspaceRootFromPackages } from './genie/internal.ts'
import effectPathPkg from './packages/@overeng/effect-path/package.json.genie.ts'
import geniePkg from './packages/@overeng/genie/package.json.genie.ts'
import megarepoPkg from './packages/@overeng/megarepo/package.json.genie.ts'
import tuiCorePkg from './packages/@overeng/tui-core/package.json.genie.ts'
import tuiReactPkg from './packages/@overeng/tui-react/package.json.genie.ts'
import utilsDevPkg from './packages/@overeng/utils-dev/package.json.genie.ts'
import utilsPkg from './packages/@overeng/utils/package.json.genie.ts'

export const rootWorkspacePackages = [
  effectPathPkg,
  geniePkg,
  megarepoPkg,
  tuiCorePkg,
  tuiReactPkg,
  utilsPkg,
  utilsDevPkg,
] as const

export const rootWorkspaceExtraMembers = [
  'context/effect/socket',
  'context/opentui',
  'packages/@overeng/effect-ai-claude-cli',
  'packages/@overeng/effect-react',
  'packages/@overeng/effect-rpc-tanstack',
  'packages/@overeng/effect-rpc-tanstack/examples/basic',
  'packages/@overeng/effect-schema-form',
  'packages/@overeng/effect-schema-form-aria',
  'packages/@overeng/notion-cli',
  'packages/@overeng/notion-effect-client',
  'packages/@overeng/notion-effect-schema',
  'packages/@overeng/oxc-config',
  'packages/@overeng/react-inspector',
] as const

export const rootWorkspaceMemberPaths = workspaceMemberPathsFromPackages({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  extraPackages: rootWorkspaceExtraMembers,
})

export default workspaceRootFromPackages({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  extraWorkspaces: rootWorkspaceExtraMembers,
  name: 'effect-utils-workspace',
  private: true,
  packageManager: 'pnpm@10.29.2',
})
