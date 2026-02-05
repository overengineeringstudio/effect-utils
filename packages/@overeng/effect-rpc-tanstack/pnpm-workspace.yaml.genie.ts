import { pnpmWorkspaceWithDepsReact } from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'
import examplePkg from './examples/basic/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDepsReact({
  pkg,
  deps: [examplePkg, utilsPkg],
  extraPackages: ['examples/basic'],
})
