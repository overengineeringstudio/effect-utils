import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_game_laws_0ac6f26523a8',
  packageName: '@overeng/game-laws',
  packagePath: 'packages/@overeng/game-laws',
  projectionSource: 'packages/@overeng/game-laws/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
