import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_dev_8614cc76469c',
  packageName: '@overeng/utils-dev',
  packagePath: 'packages/@overeng/utils-dev',
  projectionSource: 'packages/@overeng/utils-dev/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
