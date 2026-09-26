// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/content-address' }),
  dependencies: {
    external: catalog.pick('@noble/hashes', 'effect'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/content-address',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './schema': exportEntry(
        { types: './dist/src/schema.d.ts', default: './src/schema.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './schema': { types: './dist/src/schema.d.ts', default: './dist/src/schema.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
