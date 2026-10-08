// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import observerPkg from '../effect-rpc-observer/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-rpc-explorer' }),
  dependencies: {
    workspace: [otelContractPkg, observerPkg],
  },
  devDependencies: {
    external: catalog.pick(...peerDepNames, 'typescript', 'vitest', '@effect/vitest'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-rpc-explorer',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
