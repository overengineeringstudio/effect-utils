import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_alchemy_github_303965750171',
  packageName: '@overeng/alchemy-github',
  packagePath: 'packages/@overeng/alchemy-github',
  projectionSource: 'packages/@overeng/alchemy-github/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
