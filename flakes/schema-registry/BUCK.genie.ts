import { dependencyImporterFor } from '../../buck2/dependencies/generate.ts'
import { buck2TypeScriptPackageProjection } from '../../genie/buck2/javascript-candidates.ts'
import { rootWorkspacePackages } from '../../package.json.genie.ts'
import type { Buck2TypeScriptPackageProjection } from '../../repos/effect-utils/genie/buck2/typescript-package-projection.ts'

export default buck2TypeScriptPackageProjection({
  dependencyImporter: dependencyImporterFor('flakes/schema-registry'),
  packageName: 'schema-registry',
  packagePath: 'flakes/schema-registry',
  projectionSource: 'flakes/schema-registry/BUCK.genie.ts',
  rulesCell: '@rules',
  workspacePackages: rootWorkspacePackages,
  sourceRoots: ['src'],
  authorities: [{ projectFile: 'tsconfig.json' }],
} as const satisfies Buck2TypeScriptPackageProjection)
