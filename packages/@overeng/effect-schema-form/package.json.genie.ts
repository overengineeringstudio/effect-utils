import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

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
    ...catalog.pick('@types/react', 'effect', 'react', 'vitest'),
  },
  peerDependencies: {
    effect: `^${catalog.effect}`,
    react: `^${catalog.react}`,
  },
})
