// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/tui-core' }),
  devDependencies: {
    external: {
      ...catalog.pick('@types/node', 'typescript', 'vitest'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/tui-core',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry({ types: './dist/src/mod.d.ts', default: './src/mod.ts' }, { environment: 'node' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  deps,
)
