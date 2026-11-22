import { withQuickContractSources } from '../../../genie/buck2/quick-contract-inputs.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_scg_protocol_06d26f94f9e0',
  packageName: '@overeng/scg-protocol',
  packagePath: 'packages/@overeng/scg-protocol',
  projectionSource: 'packages/@overeng/scg-protocol/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest', vitestRuntime: 'bun' }],
} as const satisfies Buck2TypeScriptAdmission

export default withQuickContractSources(buck2TypeScriptPackageProjection(buck2TypeScriptAdmission), import.meta.url)
