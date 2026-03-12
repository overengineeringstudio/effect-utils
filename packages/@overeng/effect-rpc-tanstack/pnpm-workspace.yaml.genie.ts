import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from '../../../genie/internal.ts'
import basicPkg from './examples/basic/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceYaml.package({
  pkg,
  packages: [basicPkg],
  publicHoistPattern: ['react', 'react-dom', 'react-reconciler'],
  ...commonPnpmWorkspaceData,
})
