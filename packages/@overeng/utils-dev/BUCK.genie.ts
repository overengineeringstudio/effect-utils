import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_dev_8614cc76469c',
  packageName: '@overeng/utils-dev',
  packagePath: 'packages/@overeng/utils-dev',
  projectionSource: 'packages/@overeng/utils-dev/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [
    { declarationEntrypoint: 'src/node-vitest/mod.d.ts', projectFile: 'tsconfig.json' },
  ],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // Only the CLI contract suite is bounded: every otelite helper suite spawns the real
      // `otelite` capture binary and stays unbounded (decision 0026).
      excludes: [
        'src/node-vitest/otel-vitest-flush.test.ts',
        'src/otelite/Otelite.test.ts',
        'src/otelite/signal-expect.test.ts',
        'src/otelite/test-harness.test.ts',
        'src/otelite/trace-expect.test.ts',
        'src/otelite/vitest-bridge.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

const projection = buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)

export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/products:defs.bzl", "npm_package_product")

${projection.stringify(context)}
tsgo_emit(
    name = "publish-dist",
    package_tree = ":package_tree",
    declaration_entrypoint = "src/node-vitest/mod.d.ts",
    emit_declaration_only = False,
)

npm_package_product(
    name = "dist-package",
    archive_name = "overeng-utils-dev.tgz",
    dist = ":publish-dist",
    package_json = "package.json",
    product_name = "@overeng/utils-dev",
    transport_slug = "overeng-utils-dev",
    visibility = ["PUBLIC"],
)
`,
})
