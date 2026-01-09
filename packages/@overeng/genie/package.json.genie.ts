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
  devDependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
    '@types/node',
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
