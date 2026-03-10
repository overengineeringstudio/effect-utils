import { commonPnpmWorkspaceData, pnpmWorkspaceYamlFromPackage } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceYamlFromPackage({
  pkg,
  ...commonPnpmWorkspaceData,
  publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
})
