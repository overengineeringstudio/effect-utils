import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_genie_fractal_d5688859a179',
  packageName: '@overeng/genie-fractal',
  packagePath: 'packages/@overeng/genie-fractal',
  projectionSource: 'packages/@overeng/genie-fractal/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/genie',
      packagePath: 'packages/@overeng/genie',
      distTarget: '//packages/@overeng/genie:dist',
    },
    {
      packageName: '@overeng/kdl',
      packagePath: 'packages/@overeng/kdl',
      distTarget: '//packages/@overeng/kdl:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission
export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
