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
  name: '@overeng/notion-effect-client',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
    postinstall: patchPostinstall(),
  },
  exports: {
    '.': './src/mod.ts',
    './test': './src/test/integration/setup.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/notion-effect-schema'),
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/platform',
      '@effect/vitest',
      '@overeng/utils',
      '@types/node',
      'effect',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  // Expose @overeng/utils peer deps transitively (consumers need them)
  peerDependencies: utilsPkg.data.peerDependencies,
})
