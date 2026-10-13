// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import conformancePkg from '../ai-gateway-conformance/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/ai-gateway-edge' }),
  dependencies: {
    external: catalog.pick('effect', '@effect/platform-node'),
  },
  devDependencies: {
    workspace: [conformancePkg],
    external: catalog.pick('@types/node', 'typescript', 'vite', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/ai-gateway-edge',
    ...privatePackageDefaults,
    description:
      'Runtime-configured authentication and metering edge for the shared AI gateway wire',
    bin: { 'ai-gateway-edge': './src/cli.ts' },
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      bin: { 'ai-gateway-edge': './dist/src/cli.js' },
      exports: { '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' } },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
