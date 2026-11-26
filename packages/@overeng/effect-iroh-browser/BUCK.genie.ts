// @genie-bootstrap
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_iroh_browser_518949656975',
  packageName: '@overeng/effect-iroh-browser',
  packagePath: 'packages/@overeng/effect-iroh-browser',
  projectionSource: 'packages/@overeng/effect-iroh-browser/BUCK.genie.ts',
  sourceRoots: ['src', 'wasm'],
  // JavaScript and declaration files are already owned by the source census.
  runtimeFiles: ['wasm/games_iroh_wasm_bg.wasm'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
