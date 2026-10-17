import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_rpc_devtools_301a91234c2f',
  packageName: '@overeng/rpc-devtools',
  packagePath: 'packages/@overeng/rpc-devtools',
  projectionSource: 'packages/@overeng/rpc-devtools/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-rpc-observer',
      packagePath: 'packages/@overeng/effect-rpc-observer',
      distTarget: '//packages/@overeng/effect-rpc-observer:dist',
    },
    {
      packageName: '@overeng/effect-rpc-explorer',
      packagePath: 'packages/@overeng/effect-rpc-explorer',
      distTarget: '//packages/@overeng/effect-rpc-explorer:dist',
    },
    {
      packageName: '@overeng/effect-rpc-explorer-react',
      packagePath: 'packages/@overeng/effect-rpc-explorer-react',
      distTarget: '//packages/@overeng/effect-rpc-explorer-react:dist',
    },
    {
      packageName: '@overeng/meters',
      packagePath: 'packages/@overeng/meters',
      distTarget: '//packages/@overeng/meters:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/core.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest', staticCollection: true }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
