import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_rpc_explorer_react_c7c12bb1f450',
  packageName: '@overeng/effect-rpc-explorer-react',
  packagePath: 'packages/@overeng/effect-rpc-explorer-react',
  projectionSource: 'packages/@overeng/effect-rpc-explorer-react/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-rpc-explorer',
      packagePath: 'packages/@overeng/effect-rpc-explorer',
      distTarget: '//packages/@overeng/effect-rpc-explorer:dist',
    },
    {
      packageName: '@overeng/stylex-tokens',
      packagePath: 'packages/@overeng/stylex-tokens',
      distTarget: '//packages/@overeng/stylex-tokens:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest', staticCollection: true }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
