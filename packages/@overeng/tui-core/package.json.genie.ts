import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const deps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/tui-core'),
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
      '.': './src/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonData,
  deps,
)
