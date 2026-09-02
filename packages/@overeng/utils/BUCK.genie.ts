import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_07fe64e7b8ad',
  packageName: '@overeng/utils',
  packagePath: 'packages/@overeng/utils',
  projectionSource: 'packages/@overeng/utils/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-distributed-lock',
      packagePath: 'packages/@overeng/effect-distributed-lock',
      distTarget: '//packages/@overeng/effect-distributed-lock:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/isomorphic/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
