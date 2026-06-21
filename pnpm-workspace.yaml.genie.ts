import { catalog } from './genie/external.ts'
import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'

export default pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  catalogVersions: catalog,
  catalogDuplicateExceptions: [
    {
      package: 'string-width',
      reason:
        '@opentui/core@0.4.1 pins string-width@7.2.0 exactly, which pnpm dedupe cannot collapse onto the catalog 8.x',
      issue: '#821',
    },
  ],
  ...commonPnpmWorkspaceData,
})
