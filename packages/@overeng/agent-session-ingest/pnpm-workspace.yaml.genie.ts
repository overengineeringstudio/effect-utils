import { pnpmWorkspaceWithDeps } from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceWithDeps({ pkg, deps: [utilsDevPkg] })
