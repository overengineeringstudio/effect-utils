import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_effect_iroh_automerge_26e1da274aee',
  packageName: '@overeng/effect-iroh-automerge',
  packagePath: 'packages/@overeng/effect-iroh-automerge',
  projectionSource: 'packages/@overeng/effect-iroh-automerge/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-iroh-browser',
      packagePath: 'packages/@overeng/effect-iroh-browser',
      distTarget: '//packages/@overeng/effect-iroh-browser:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
