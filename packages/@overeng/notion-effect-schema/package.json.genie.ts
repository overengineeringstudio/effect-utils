import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = ['effect'] as const

export default packageJson({
  name: '@overeng/notion-effect-schema',
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
