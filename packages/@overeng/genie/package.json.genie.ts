import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/genie',
  ...privatePackageDefaults,
  exports: {
    '.': './src/lib/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/lib/mod.js',
      './cli': './dist/cli.js',
    },
  },
  // Genie must not use any runtime dependencies (only bundled/dev dependencies)
  dependencies: [],
  devDependencies: [
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
  ],
  peerDependencies: {
    '@effect/cli': '^',
    '@effect/platform': '^',
    '@effect/platform-node': '^',
    effect: '^',
  },
})
