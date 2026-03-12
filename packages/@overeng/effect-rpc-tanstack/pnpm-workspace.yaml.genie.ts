import { commonPnpmWorkspaceData, pnpmWorkspaceYamlFromPackage } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceYamlFromPackage({
  pkg,
  extraPackages: ['examples/basic'],
  publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
  ...commonPnpmWorkspaceData,
})
