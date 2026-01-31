import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

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
  dependencies: {
    ...catalog.pick('cli-truncate'),
  },
  devDependencies: {
    ...catalog.pick('@types/node', 'typescript', 'vitest'),
  },
})
