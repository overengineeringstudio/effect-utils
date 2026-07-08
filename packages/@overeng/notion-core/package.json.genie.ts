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
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-core' }),
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick('@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/notion-core',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'isomorphic-es2024' }),
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
