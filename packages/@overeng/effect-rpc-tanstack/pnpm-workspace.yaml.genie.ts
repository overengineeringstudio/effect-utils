import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceYaml.package({
  pkg,
  extraPackages: ['examples/basic'],
  publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
  ...commonPnpmWorkspaceData,
})
