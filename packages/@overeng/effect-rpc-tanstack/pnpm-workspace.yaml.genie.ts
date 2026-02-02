import { pnpmWorkspaceReactFromPackageJson } from '../../../genie/internal.ts'
import examplePkg from './examples/basic/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceReactFromPackageJson(examplePkg, {
  include: [pkg],
  extraPackages: ['examples/basic'],
})
