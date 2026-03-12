import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspaceExtraMembers, rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  extraPackages: rootWorkspaceExtraMembers,
  ...commonPnpmWorkspaceData,
})
