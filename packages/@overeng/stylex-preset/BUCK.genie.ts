import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_stylex_preset_eec8ac17a1d4',
  packageName: '@overeng/stylex-preset',
  packagePath: 'packages/@overeng/stylex-preset',
  projectionSource: 'packages/@overeng/stylex-preset/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/tokens.stylex.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
