import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/otel-contract' }),
  dependencies: {
    workspace: [contentAddressPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick(...peerDepNames, '@types/node', 'typescript', 'vitest'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/otel-contract',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'isomorphic-es2024' }),
      // Design-time projector (Layer 2 authoring + AST → registry fragment). Imported ONLY by
      // `.genie.ts` files; never by runtime product code (verified out of the `.` bundle).
      './registry': exportEntry('./src/registry.ts', { environment: 'isomorphic-es2024' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './registry': './dist/registry.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
