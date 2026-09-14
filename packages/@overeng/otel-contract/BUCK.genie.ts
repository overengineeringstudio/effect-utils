import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_otel_contract_071b3792a33c',
  packageName: '@overeng/otel-contract',
  packagePath: 'packages/@overeng/otel-contract',
  projectionSource: 'packages/@overeng/otel-contract/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/content-address',
      packagePath: 'packages/@overeng/content-address',
      distTarget: '//packages/@overeng/content-address:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

const projection = buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)

export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/products:defs.bzl", "npm_package_product")

${projection.stringify(context)}

npm_package_product(
    name = "dist-package",
    archive_name = "overeng-otel-contract.tgz",
    dist = ":dist",
    package_json = "package.json",
    product_name = "@overeng/otel-contract",
    transport_slug = "overeng-otel-contract",
    package_dependencies = [
        "//packages/@overeng/content-address:dist-package",
    ],
    visibility = ["PUBLIC"],
)
`,
})
