import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_rpc_explorer_0ce9c9212c35',
  packageName: '@overeng/effect-rpc-explorer',
  packagePath: 'packages/@overeng/effect-rpc-explorer',
  projectionSource: 'packages/@overeng/effect-rpc-explorer/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
