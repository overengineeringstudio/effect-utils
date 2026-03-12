import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'

export default pnpmWorkspaceYaml.root({
  dir: import.meta.dirname,
  packages: [],
  extraPackages: ['.'],
  ...commonPnpmWorkspaceData,
})
