import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_changelog_9106b3b1ef0f',
  packageName: '@overeng/changelog',
  packagePath: 'packages/@overeng/changelog',
  projectionSource: 'packages/@overeng/changelog/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The coverage check spawns real git in temporary repositories and stays source-owned and
      // unbounded (decision 0026).
      excludes: ['src/node/check.integration.test.ts'],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
