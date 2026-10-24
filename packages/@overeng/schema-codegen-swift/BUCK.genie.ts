import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_schema_codegen_swift_b78dd9bcfa9a',
  packageName: '@overeng/schema-codegen-swift',
  packagePath: 'packages/@overeng/schema-codegen-swift',
  projectionSource: 'packages/@overeng/schema-codegen-swift/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [],
  authorities: [
    { declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json', projectInputs: [] },
  ],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
