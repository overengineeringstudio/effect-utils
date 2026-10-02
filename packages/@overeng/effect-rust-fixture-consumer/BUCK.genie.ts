import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_effect_rust_c20e5aed8413',
  packageName: '@overeng/effect-rust-fixture-consumer',
  packagePath: 'packages/@overeng/effect-rust-fixture-consumer',
  projectionSource: 'packages/@overeng/effect-rust-fixture-consumer/BUCK.genie.ts',
  sourceRoots: ['src'],
  generatedDependencies: {
    'effect-rust-fixture': '//rust/effect-rust-fixtures/service:service',
  },
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-rust',
      packagePath: 'packages/@overeng/effect-rust',
      distTarget: '//packages/@overeng/effect-rust:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
} as const satisfies Buck2TypeScriptAdmission

const projection = buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
export default createGenieOutput({
  data: projection.data,
  stringify: (ctx) =>
    [
      'load("//buck2/rust:interop.bzl", "rust_interop_consumer_smoke")',
      '',
      projection.stringify(ctx),
      ...['node', 'bun'].flatMap((runtime) => [
        'rust_interop_consumer_smoke(',
        `    name = "consumer-smoke-${runtime}",`,
        '    package_tree = ":package_tree",',
        '    dist = ":dist",',
        `    runtime = "${runtime}",`,
        '    visibility = ["PUBLIC"],',
        ')',
        '',
      ]),
    ].join('\n'),
})
