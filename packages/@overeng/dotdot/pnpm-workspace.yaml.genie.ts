import { commonPnpmWorkspaceData, pnpmWorkspaceYamlFromPackages } from '../../../genie/internal.ts'

export default pnpmWorkspaceYamlFromPackages({
  dir: import.meta.dirname,
  packages: [],
  extraPackages: ['.'],
  ...commonPnpmWorkspaceData,
})
