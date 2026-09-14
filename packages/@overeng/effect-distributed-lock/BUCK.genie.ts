import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_distributed_lock_f36a75b36a62',
  packageName: '@overeng/effect-distributed-lock',
  packagePath: 'packages/@overeng/effect-distributed-lock',
  projectionSource: 'packages/@overeng/effect-distributed-lock/BUCK.genie.ts',
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

npm_package_product(
    name = "dist-package",
    archive_name = "overeng-effect-distributed-lock.tgz",
    dist = ":dist",
    package_json = "package.json",
    product_name = "@overeng/effect-distributed-lock",
    transport_slug = "overeng-effect-distributed-lock",
    visibility = ["PUBLIC"],
)
`,
})
