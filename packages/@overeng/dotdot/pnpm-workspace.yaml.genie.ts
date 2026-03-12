import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'

export default pnpmWorkspaceYaml.manual({
  packages: ['.'],
  ...commonPnpmWorkspaceData,
})
