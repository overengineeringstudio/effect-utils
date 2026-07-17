import { projectionArtifact } from './genie/external.ts'
import rootPackageJson from './package.json.genie.ts'
import rootPnpmWorkspaceYaml from './pnpm-workspace.yaml.genie.ts'

const packageManager = rootPackageJson.data.packageManager ?? 'pnpm@unknown'
const pnpmVersion = packageManager.startsWith('pnpm@')
  ? packageManager.slice('pnpm@'.length)
  : packageManager
const workspaceData = rootPnpmWorkspaceYaml.data

export default projectionArtifact.json({
  schemaVersion: 1,
  data: {
    contract: 'effect-utils/pnpm-install-contract',
    packageManager: {
      name: 'pnpm',
      version: pnpmVersion,
    },
    storeContract: {
      owner: 'pnpm',
      layoutVersion: 'v11',
      storeDir: workspaceData.storeDir,
      sharedFilesStore: {
        enabledForLocalDev: true,
        disabledInCi: true,
      },
      virtualStore: {
        scope: 'materialization-root',
        path: 'node_modules/.pnpm',
      },
    },
    dependencyGraphContract: {
      packageManager: {
        name: 'pnpm',
        version: pnpmVersion,
      },
      allowBuilds: workspaceData.allowBuilds,
      packageExtensions: workspaceData.packageExtensions,
    },
    installPolicy: {
      dedupePeerDependents: workspaceData.dedupePeerDependents,
      ignoreScripts: workspaceData.ignoreScripts,
      minimumReleaseAgeExclude: workspaceData.minimumReleaseAgeExclude,
      optimisticRepeatInstall: workspaceData.optimisticRepeatInstall,
      packageImportMethod: workspaceData.packageImportMethod,
      peerDependencyRules: workspaceData.peerDependencyRules,
      pmOnFail: workspaceData.pmOnFail,
      sideEffectsCache: workspaceData.sideEffectsCache,
      strictPeerDependencies: workspaceData.strictPeerDependencies,
      strictStorePkgContentCheck: workspaceData.strictStorePkgContentCheck,
      supportedArchitectures: workspaceData.supportedArchitectures,
      verifyDepsBeforeRun: workspaceData.verifyDepsBeforeRun,
      verifyStoreIntegrity: workspaceData.verifyStoreIntegrity,
    },
    workspaceManifestContract: {
      injectWorkspacePackages: workspaceData.injectWorkspacePackages,
      allowUnusedPatches: workspaceData.allowUnusedPatches,
      patchedDependencies: workspaceData.patchedDependencies,
      packages: workspaceData.packages,
    },
    metadata: {
      pnpmStoreOwnership: {
        filesLifecycle: 'pnpm-owned content-addressed files store',
        virtualStoreLifecycle: 'Materialization-Root-owned rebuildable dependency graph',
      },
      nixIntegration: {
        liveVirtualStoreScope: 'materialization-root',
        fixedOutputDependencyPrepUsesSameVirtualStoreScope: true,
      },
      buck2Integration: {
        consumeContractArtifact: true,
        avoidNodeModulesLayoutAsApi: true,
      },
    },
  },
})
