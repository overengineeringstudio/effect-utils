// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/schema-codegen' }),
  dependencies: { external: catalog.pick('effect') },
  devDependencies: {
    external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/schema-codegen',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './annotations': exportEntry(
        { types: './dist/src/annotations.d.ts', default: './src/annotations.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './annotations': {
          types: './dist/src/annotations.d.ts',
          default: './dist/src/annotations.js',
        },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
