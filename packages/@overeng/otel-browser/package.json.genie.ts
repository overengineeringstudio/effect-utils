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
  workspace: workspaceMember({ memberPath: 'packages/@overeng/otel-browser' }),
  dependencies: { workspace: [otelContractPkg] },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick('effect', 'vite', '@types/bun', '@types/node', 'typescript', 'vitest'),
  },
  peerDependencies: { external: catalog.pick('effect', 'vite') },
})

export default packageJson(
  {
    name: '@overeng/otel-browser',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './vite': exportEntry(
        { types: './dist/src/vite.d.ts', default: './src/vite.ts' },
        { environment: 'node' },
      ),
    },
    peerDependenciesMeta: { vite: { optional: true } },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './vite': { types: './dist/src/vite.d.ts', default: './dist/src/vite.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
