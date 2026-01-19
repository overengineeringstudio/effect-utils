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
  name: '@overeng/genie',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
    postinstall: patchPostinstall(),
  },
  exports: {
    '.': './src/runtime/mod.ts',
    './cli': './src/build/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/src/runtime/mod.js',
      './cli': './dist/src/build/mod.js',
    },
  },
  // Genie must not use any runtime dependencies (only bundled/dev dependencies)
  dependencies: {},
  devDependencies: {
    ...utilsPkg.data.peerDependencies,
    ...catalog.pick(
      '@overeng/utils',
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/printer',
      '@effect/printer-ansi',
      '@effect/vitest',
      '@types/node',
      '@types/bun',
      'effect',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers('@effect/cli'),
  },
})
