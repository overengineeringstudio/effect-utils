import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/notion-effect-client',
  ...privatePackageDefaults,
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
  dependencies: ['@overeng/notion-effect-schema'],
  devDependencies: [
    '@effect/platform',
    '@effect/vitest',
    '@overeng/utils',
    '@types/node',
    'effect',
    'vitest',
  ],
  peerDependencies: {
    '@effect/platform': '^',
    effect: '^',
  },
})
