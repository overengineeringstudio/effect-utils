import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_ai_gateway_edge_944509ea8eb5',
  packageName: '@overeng/ai-gateway-edge',
  packagePath: 'packages/@overeng/ai-gateway-edge',
  projectionSource: 'packages/@overeng/ai-gateway-edge/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [{
    packageName: '@overeng/ai-gateway-conformance',
    packagePath: 'packages/@overeng/ai-gateway-conformance',
    distTarget: '//packages/@overeng/ai-gateway-conformance:dist',
  }],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
