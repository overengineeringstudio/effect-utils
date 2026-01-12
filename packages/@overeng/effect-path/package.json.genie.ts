import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

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
    ...catalog.pick(
      '@effect/platform',
      '@effect/vitest',
      '@types/node',
      'effect',
      'vitest',
    ),
  },
  peerDependencies: {
    '@effect/platform': `^${catalog['@effect/platform']}`,
    effect: `^${catalog.effect}`,
  },
})
