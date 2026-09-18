import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_notion_effect_schema_4393910d3e7b',
  packageName: '@overeng/notion-effect-schema',
  packagePath: 'packages/@overeng/notion-effect-schema',
  projectionSource: 'packages/@overeng/notion-effect-schema/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/notion-core',
      packagePath: 'packages/@overeng/notion-core',
      distTarget: '//packages/@overeng/notion-core:dist',
    },
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
    archive_name = "overeng-notion-effect-schema.tgz",
    dist = ":publish-dist",
    package_json = "package.json",
    product_name = "@overeng/notion-effect-schema",
    transport_slug = "overeng-notion-effect-schema",
    package_dependencies = [
        "//packages/@overeng/notion-core:dist-package",
    ],
    visibility = ["PUBLIC"],
)
`,
})
