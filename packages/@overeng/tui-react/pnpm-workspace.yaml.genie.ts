import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceYaml.package({
  pkg,
  ...commonPnpmWorkspaceData,
  publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
})
