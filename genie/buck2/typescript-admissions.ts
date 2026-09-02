import { Buffer } from 'node:buffer'

import type { Buck2TypeScriptPackageProjection } from './typescript-package-projection.ts'

/** Buck TypeScript projection input plus editor publication admission. */
export type Buck2TypeScriptAdmission = Buck2TypeScriptPackageProjection & {
  readonly editorViewConsumer: boolean
}

/** Semantic registry for every package admitted to the Buck TypeScript projection. */
export const buck2TypeScriptAdmissions = {
  contentAddress: {
    dependencyImporter:
      '//buck2/dependencies:importer_packages_overeng_content_address_a119c50f74bb',
    packageName: '@overeng/content-address',
    packagePath: 'packages/@overeng/content-address',
    projectionSource: 'packages/@overeng/content-address/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
  effectDistributedLock: {
    dependencyImporter:
      '//buck2/dependencies:importer_packages_overeng_effect_distributed_lock_f36a75b36a62',
    packageName: '@overeng/effect-distributed-lock',
    packagePath: 'packages/@overeng/effect-distributed-lock',
    projectionSource: 'packages/@overeng/effect-distributed-lock/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
  otelContract: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_otel_contract_071b3792a33c',
    packageName: '@overeng/otel-contract',
    packagePath: 'packages/@overeng/otel-contract',
    projectionSource: 'packages/@overeng/otel-contract/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
  tuiCore: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_core_45029ece7ddb',
    packageName: '@overeng/tui-core',
    packagePath: 'packages/@overeng/tui-core',
    projectionSource: 'packages/@overeng/tui-core/BUCK.genie.ts',
    sourceRoots: ['src', 'test'],
    editorViewConsumer: true,
  },
  tuiReact: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_react_f20a858a9232',
    packageName: '@overeng/tui-react',
    packagePath: 'packages/@overeng/tui-react',
    projectionSource: 'packages/@overeng/tui-react/BUCK.genie.ts',
    projectFile: 'tsconfig.buck.json',
    sourceRoots: ['src', 'test', 'examples'],
    workspaceSiblings: [
      {
        packageName: '@overeng/tui-core',
        packagePath: 'packages/@overeng/tui-core',
        distTarget: '//packages/@overeng/tui-core:dist',
      },
      {
        packageName: '@overeng/utils',
        packagePath: 'packages/@overeng/utils',
        sourceRoots: ['src'],
      },
      {
        packageName: '@overeng/utils-dev',
        packagePath: 'packages/@overeng/utils-dev',
        sourceRoots: ['src'],
      },
    ],
    editorViewConsumer: false,
  },
  stylexTokens: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_stylex_tokens_eec8ac17a1d4',
    packageName: '@overeng/stylex-tokens',
    packagePath: 'packages/@overeng/stylex-tokens',
    projectionSource: 'packages/@overeng/stylex-tokens/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
  utils: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_07fe64e7b8ad',
    packageName: '@overeng/utils',
    packagePath: 'packages/@overeng/utils',
    projectionSource: 'packages/@overeng/utils/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
  utilsDev: {
    dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_dev_8614cc76469c',
    packageName: '@overeng/utils-dev',
    packagePath: 'packages/@overeng/utils-dev',
    projectionSource: 'packages/@overeng/utils-dev/BUCK.genie.ts',
    sourceRoots: ['src'],
    editorViewConsumer: false,
  },
} as const satisfies Record<string, Buck2TypeScriptAdmission>

/** Byte-sorted package paths whose editor dependency surface is currently admitted. */
export const editorViewConsumerPackagePaths = Object.values(buck2TypeScriptAdmissions)
  .filter((admission) => admission.editorViewConsumer === true)
  .map((admission) => admission.packagePath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
