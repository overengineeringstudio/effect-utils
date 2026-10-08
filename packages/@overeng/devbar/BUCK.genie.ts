import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_devbar_d9a9d68ecdb8',
  packageName: '@overeng/devbar',
  packagePath: 'packages/@overeng/devbar',
  projectionSource: 'packages/@overeng/devbar/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/stylex-tokens',
      packagePath: 'packages/@overeng/stylex-tokens',
      distTarget: '//packages/@overeng/stylex-tokens:dist',
    },
    {
      packageName: '@overeng/meters',
      packagePath: 'packages/@overeng/meters',
      distTarget: '//packages/@overeng/meters:dist',
    },
    {
      packageName: '@overeng/rpc-devtools',
      packagePath: 'packages/@overeng/rpc-devtools',
      distTarget: '//packages/@overeng/rpc-devtools:dist',
    },
    {
      packageName: '@overeng/effect-rpc-explorer',
      packagePath: 'packages/@overeng/effect-rpc-explorer',
      distTarget: '//packages/@overeng/effect-rpc-explorer:dist',
    },
    {
      packageName: '@overeng/effect-rpc-explorer-react',
      packagePath: 'packages/@overeng/effect-rpc-explorer-react',
      distTarget: '//packages/@overeng/effect-rpc-explorer-react:dist',
    },
    {
      packageName: '@overeng/effect-rpc-observer',
      packagePath: 'packages/@overeng/effect-rpc-observer',
      distTarget: '//packages/@overeng/effect-rpc-observer:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [{ name: 'test', runner: 'vitest', staticCollection: true }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
