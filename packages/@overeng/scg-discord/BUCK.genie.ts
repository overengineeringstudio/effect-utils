import { withQuickContractSources } from '../../../genie/buck2/quick-contract-inputs.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_scg_discord_c960a5e53e1e',
  packageName: '@overeng/scg-discord',
  packagePath: 'packages/@overeng/scg-discord',
  projectionSource: 'packages/@overeng/scg-discord/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/scg-protocol',
      packagePath: 'packages/@overeng/scg-protocol',
      distTarget: '//packages/@overeng/scg-protocol:dist',
    },
    {
      packageName: '@overeng/scg-authority',
      packagePath: 'packages/@overeng/scg-authority',
      distTarget: '//packages/@overeng/scg-authority:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest', vitestRuntime: 'bun' }],
} as const satisfies Buck2TypeScriptAdmission

export default withQuickContractSources(
  buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  import.meta.url,
)
