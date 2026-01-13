import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  ...privatePackageDefaults,
  name: '@overeng/mono',
  scripts: {
    ...effectLspScripts,
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
    ...catalog.pick('@types/node', 'vitest', '@effect/vitest'),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers('@effect/cli'),
  },
})
