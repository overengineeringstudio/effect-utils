import { pnpmWorkspaceWithDepsReact } from '../../../genie/internal.ts'
import examplePkg from './examples/basic/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDepsReact(pkg, [examplePkg], {
  extraPackages: ['examples/basic'],
})
