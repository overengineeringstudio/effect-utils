import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/cli-ui',
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
  devDependencies: {
    ...catalog.pick('@types/node', 'typescript'),
  },
})
