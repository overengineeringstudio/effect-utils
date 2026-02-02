import { createWorkspaceRegistry, pnpmWorkspaceReactFromPackageJson } from '../../../genie/internal.ts'
import { workspaceRegistry } from '../../../genie/workspace-registry.ts'
import examplePkg from './examples/basic/package.json.genie.ts'
import pkg from './package.json.genie.ts'

// Merge global registry with local packages for transitive resolution
const localRegistry = new Map([
  ...workspaceRegistry,
  ...createWorkspaceRegistry([pkg, examplePkg]),
])

export default pnpmWorkspaceReactFromPackageJson(examplePkg, {
  registry: localRegistry,
  extraPackages: ['examples/basic'],
})
