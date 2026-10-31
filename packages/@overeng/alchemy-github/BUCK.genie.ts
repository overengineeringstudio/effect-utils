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
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // Credentialed/manual provider access belongs to the source/unbounded complement.
      // Sandbox.live fails closed when its explicit live gate is enabled.
      excludes: ['src/App.live.test.ts', 'src/Sandbox.live.test.ts'],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
