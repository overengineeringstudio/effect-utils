import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_effect_rust_c20e5aed8413',
  packageName: '@overeng/effect-rust',
  packagePath: 'packages/@overeng/effect-rust',
  projectionSource: 'packages/@overeng/effect-rust/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [],
  authorities: [{
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
    projectInputs: ['src/compiler/fixtures/vectors.json'],
  }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
