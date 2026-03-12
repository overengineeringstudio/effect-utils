import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'

export default pnpmWorkspaceYaml.root({
  packages: [],
  extraPackages: ['.'],
  ...commonPnpmWorkspaceData,
})
