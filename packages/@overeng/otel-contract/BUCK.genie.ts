import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_otel_contract_071b3792a33c',
  packageName: '@overeng/otel-contract',
  packagePath: 'packages/@overeng/otel-contract',
  projectionSource: 'packages/@overeng/otel-contract/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
