import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

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
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
