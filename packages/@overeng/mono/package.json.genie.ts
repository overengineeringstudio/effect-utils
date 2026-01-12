import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  ...privatePackageDefaults,
  name: '@overeng/mono',
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
    ...catalog.pick(
      '@overeng/utils',
      '@effect/cli',
      '@effect/experimental',
      '@effect/platform',
      '@effect/platform-node',
      'effect',
    ),
  },
  devDependencies: {
    ...catalog.pick('@types/node', 'typescript'),
  },
  peerDependencies: {
    ...utilsPkg.data.peerDependencies,
    '@effect/cli': `^${catalog['@effect/cli']}`,
  },
  patchedDependencies: {
    ...utilsPkg.data.patchedDependencies,
  },
})
