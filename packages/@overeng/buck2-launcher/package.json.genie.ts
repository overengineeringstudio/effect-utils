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
  workspace: workspaceMember({ memberPath: 'packages/@overeng/buck2-launcher' }),
  dependencies: {
    workspace: [otelContractPkg],
    external: catalog.pick('effect'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick('@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/buck2-launcher',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/launcher.ts', { environment: 'node' }),
      './receipt': exportEntry('./src/receipt.ts', { environment: 'node' }),
      './contract': exportEntry('./src/buck2-launcher.contract.ts', {
        environment: 'isomorphic-es2024',
      }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/launcher.js',
        './receipt': './dist/receipt.js',
        './contract': './dist/buck2-launcher.contract.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
