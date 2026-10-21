import { pnpmInstallStorageContractV2 as storage, projectionArtifact } from '../../../genie/external.ts'
import manifest from './package.json.genie.ts'
import workspace from './pnpm-workspace.yaml.genie.ts'

const packageManager = {
  name: 'pnpm',
  version: (manifest.data.packageManager ?? 'pnpm@unknown').slice('pnpm@'.length),
}

export default projectionArtifact.json({
  schemaVersion: 2,
  data: {
    contract: 'effect-utils/pnpm-install-contract',
    packageManager,
    storeContract: storage.storeContract,
    dependencyGraphContract: { packageManager, allowBuilds: workspace.data.allowBuilds },
    installPolicy: { ignoreScripts: workspace.data.ignoreScripts },
    workspaceManifestContract: { packages: workspace.data.packages },
  },
})
