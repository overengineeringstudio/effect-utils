import {
  projectionArtifact,
  type PnpmInstallStorageContractV2,
} from './genie/external.ts'
import rootPackageJson from './package.json.genie.ts'
import rootPnpmWorkspaceYaml from './pnpm-workspace.yaml.genie.ts'

const packageManager = rootPackageJson.data.packageManager ?? 'pnpm@unknown'
const pnpmVersion = packageManager.startsWith('pnpm@')
  ? packageManager.slice('pnpm@'.length)
  : packageManager
const workspaceData = rootPnpmWorkspaceYaml.data
const storage = {
  storeContract: {
    owner: 'pnpm',
    layoutVersion: 'v11',
    localDevelopment: {
      scope: 'host-user',
      trustBoundary: 'same-os-user',
      defaultPath: '~/.local/share/pnpm/store-shared-v1',
      pathOverrideEnvironmentVariable: 'PNPM_SHARED_STORE_DIR',
      contentAddressedFiles: 'shared',
      derivedIndex: 'shared-pnpm-owned',
    },
    ci: {
      scope: 'job',
    },
    virtualStore: {
      scope: 'materialization-root',
      path: 'node_modules/.pnpm',
      global: false,
    },
  },
  packageImportMethod: {
    live: {
      method: 'auto',
      owner: 'pnpm',
      linuxSameDeviceRequired: true,
    },
    nixPreparedDependencies: {
      scope: 'independent-builder-policy',
    },
  },
} satisfies PnpmInstallStorageContractV2

export default projectionArtifact.json({
  schemaVersion: 2,
  data: {
    contract: 'effect-utils/pnpm-install-contract',
    packageManager: {
      name: 'pnpm',
      version: pnpmVersion,
    },
    storeContract: storage.storeContract,
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
      packageImportMethod: storage.packageImportMethod,
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
        cacheLifecycle: 'pnpm-owned disposable Store Cache',
        derivedIndexLifecycle: 'shared only inside one same-user trust boundary',
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
