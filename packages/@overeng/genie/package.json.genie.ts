import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  name: '@overeng/genie',
  ...privatePackageDefaults,
  exports: {
    '.': './src/runtime/mod.ts',
    './cli': './src/build/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/src/runtime/mod.js',
      './cli': './dist/src/build/cli.js',
    },
  },
  // Genie must not use any runtime dependencies (only bundled/dev dependencies)
  dependencies: {},
  devDependencies: {
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
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: {
    ...utilsPkg.data.peerDependencies,
    '@effect/cli': `^${catalog['@effect/cli']}`,
  },
  patchedDependencies: {
    ...utilsPkg.data.patchedDependencies,
  },
})
