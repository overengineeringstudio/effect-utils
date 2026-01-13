import { catalog, packageJson, patchPostinstall, privatePackageDefaults } from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  ...privatePackageDefaults,
  name: '@overeng/mono',
  scripts: {
    postinstall: patchPostinstall(),
  },
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
    ...catalog.pick('@types/node', 'typescript', 'vitest', '@effect/vitest'),
  },
  peerDependencies: {
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers('@effect/cli'),
  },
})
