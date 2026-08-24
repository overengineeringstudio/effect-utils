// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/buck2-tools' }),
  dependencies: {
    workspace: [otelContractPkg],
    external: catalog.pick('effect'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick(
      '@effect/opentelemetry',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/vitest',
      '@types/node',
      'typescript',
      'vitest',
    ),
  },
})

export default packageJson(
  {
    name: '@overeng/buck2-tools',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'node' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
