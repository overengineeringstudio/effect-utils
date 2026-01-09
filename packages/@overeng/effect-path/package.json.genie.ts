import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/effect-path',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  devDependencies: ['@effect/platform', '@effect/vitest', '@types/node', 'effect', 'vitest'],
  peerDependencies: {
    '@effect/platform': '^',
    effect: '^',
  },
})
