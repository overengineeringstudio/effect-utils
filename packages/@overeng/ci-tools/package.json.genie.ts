import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDepNames = [
  '@effect/cli',
  '@effect/cluster',
  '@effect/experimental',
  '@effect/opentelemetry',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  '@effect/workflow',
  '@playwright/test',
  'effect',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/ci-tools' }),
  dependencies: {
    workspace: [otelContractPkg, utilsPkg],
    external: catalog.pick(...runtimeDepNames),
  },
  devDependencies: {
    workspace: [utilsDevPkg, utilsPkg],
    external: catalog.pick('@effect/vitest', '@types/bun', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/ci-tools',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'node' }),
      './cli': exportEntry('./src/cli-command.ts', { environment: 'node' }),
    },
    publishConfig: {
      access: 'public',
      bin: {
        'ci-tools': './dist/bin/ci-tools.js',
      },
      exports: {
        '.': './dist/src/mod.js',
        './cli': './dist/src/cli-command.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
