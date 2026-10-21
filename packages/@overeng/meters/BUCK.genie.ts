import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_meters_03b79beacb4f',
  packageName: '@overeng/meters',
  packagePath: 'packages/@overeng/meters',
  projectionSource: 'packages/@overeng/meters/BUCK.genie.ts',
  sourceRoots: ['src', 'e2e'],
  workspaceSiblings: [],
  authorities: [{ declarationEntrypoint: 'index.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      staticCollection: true,
      excludes: [
        'e2e/meter-strip.pw.test.ts',
        'e2e/meter-tile.pw.test.ts',
        'e2e/perf-gates.pw.test.ts',
      ],
      sourceOwners: {
        'e2e/meter-strip.pw.test.ts': 'test:pw:meters',
        'e2e/meter-tile.pw.test.ts': 'test:pw:meters',
        'e2e/perf-gates.pw.test.ts': 'test:pw:meters',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
