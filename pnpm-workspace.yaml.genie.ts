import { commonPnpmWorkspaceData, pnpmWorkspaceYamlFromPackages } from './genie/internal.ts'
import { rootWorkspaceExtraMembers, rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYamlFromPackages({
  dir: import.meta.dirname,
  packages: rootWorkspacePackages,
  extraPackages: rootWorkspaceExtraMembers,
  ...commonPnpmWorkspaceData,
})
