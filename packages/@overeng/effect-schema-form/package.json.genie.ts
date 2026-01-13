import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = ['effect', 'react'] as const

export default packageJson({
  name: '@overeng/effect-schema-form',
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
    ...catalog.pick(...peerDepNames, '@types/react', 'vitest'),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
