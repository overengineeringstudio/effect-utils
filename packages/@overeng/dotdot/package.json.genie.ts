import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  'effect',
] as const

export default packageJson({
  name: '@overeng/dotdot',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
    postinstall: patchPostinstall(),
  },
  exports: {
    '.': './src/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './cli': './dist/cli.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/utils'),
  },
  devDependencies: {
    ...catalog.pick(...peerDepNames, '@effect/vitest', '@types/bun', '@types/node', 'vitest'),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers(...peerDepNames),
  },
})
