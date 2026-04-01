import { catalog } from './genie/external.ts'
import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  catalogVersions: catalog,
  ...commonPnpmWorkspaceData,
})
