import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = ['@effect/platform', 'effect'] as const

export default packageJson({
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
  devDependencies: {
    ...catalog.pick(...peerDepNames, '@effect/vitest', '@types/node', 'vitest'),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
