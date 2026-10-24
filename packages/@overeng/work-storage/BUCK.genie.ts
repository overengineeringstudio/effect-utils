import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_work_storage_e5759f026d0d',
  packageName: '@overeng/work-storage',
  packagePath: 'packages/@overeng/work-storage',
  projectionSource: 'packages/@overeng/work-storage/BUCK.genie.ts',
  sourceRoots: ['src'],
  runtimeFiles: ['protocol.schema.json', 'fixtures/conformance.json'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest' }],
} as const satisfies Buck2TypeScriptAdmission

const projection = buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)

export default createGenieOutput({
  ...projection,
  stringify: (context) => `${projection.stringify(context)}
native.export_file(
    name = "protocol-schema",
    src = "protocol.schema.json",
    visibility = ["PUBLIC"],
)
native.export_file(
    name = "conformance-fixtures",
    src = "fixtures/conformance.json",
    visibility = ["PUBLIC"],
)
`,
})
