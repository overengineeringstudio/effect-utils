import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_content_address_a119c50f74bb',
  packageName: '@overeng/content-address',
  packagePath: 'packages/@overeng/content-address',
  projectionSource: 'packages/@overeng/content-address/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
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
    declaration_entrypoint = "src/mod.d.ts",
    emit_declaration_only = False,
)

npm_package_product(
    name = "dist-package",
    archive_name = "overeng-content-address.tgz",
    dist = ":publish-dist",
    transport_slug = "overeng-content-address",
    package_json = "package.json",
    product_name = "@overeng/content-address",
    visibility = ["PUBLIC"],
)
`,
})
