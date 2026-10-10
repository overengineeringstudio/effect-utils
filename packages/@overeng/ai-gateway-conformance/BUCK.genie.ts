import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import {
  buck2TypeScriptPackageProjection,
  discoverPackageFiles,
} from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_ai_gateway_conformance_9e6369708c70',
  packageName: '@overeng/ai-gateway-conformance',
  packagePath: 'packages/@overeng/ai-gateway-conformance',
  projectionSource: 'packages/@overeng/ai-gateway-conformance/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  runtimeFiles: [
    'case.schema.json',
    ...discoverPackageFiles({
      packagePath: 'packages/@overeng/ai-gateway-conformance',
      sourceRoots: ['cases'],
      admit: (file) => file.endsWith('.json'),
    }),
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
