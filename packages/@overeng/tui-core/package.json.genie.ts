import {
  catalog,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

export default packageJson({
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
  dependencies: {},
  devDependencies: {
    ...catalog.pick('@types/node', 'typescript', 'vitest'),
  },
} satisfies PackageJsonData)
