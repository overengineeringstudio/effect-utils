import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { workspaceMemberPaths } from './genie/packages.ts'

export default pnpmWorkspaceYaml({
  packages: [...workspaceMemberPaths],
  ...commonPnpmWorkspaceData,
})
