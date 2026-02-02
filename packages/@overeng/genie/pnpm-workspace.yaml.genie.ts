import { pnpmWorkspaceReactFromPackageJson } from '../../../genie/internal.ts'
import { workspaceRegistry } from '../../../genie/workspace-registry.ts'
import pkg from './package.json.genie.ts'

export default pnpmWorkspaceReactFromPackageJson(pkg, { registry: workspaceRegistry })
