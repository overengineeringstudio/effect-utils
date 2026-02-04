import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

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
  scripts: {
    ...effectLspScripts,
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@effect/platform-node',
      '@effect/vitest',
      '@types/node',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
