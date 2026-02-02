import { pnpmWorkspaceFromPackageJson } from '../../../genie/internal.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceFromPackageJson(pkg)
