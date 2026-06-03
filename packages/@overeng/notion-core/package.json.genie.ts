import {
  catalog,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonData,
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
      '.': './src/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
