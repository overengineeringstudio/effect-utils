import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

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
    '@effect/vitest': catalog['@effect/vitest'],
    '@types/node': catalog['@types/node'],
    effect: catalog.effect,
    vitest: catalog.vitest,
  },
  peerDependencies: {
    effect: `^${catalog.effect}`,
  },
})
