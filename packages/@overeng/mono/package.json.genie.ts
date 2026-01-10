import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
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
  dependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
    '@overeng/utils',
    'effect',
  ],
  devDependencies: ['@types/node', 'typescript'],
  peerDependencies: {
    '@effect/cli': '^',
    '@effect/platform': '^',
    '@effect/platform-node': '^',
    effect: '^',
  },
})
