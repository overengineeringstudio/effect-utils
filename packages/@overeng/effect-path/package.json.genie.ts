import { pnpmPatchedDependencies } from '../../../genie/external.ts'
import {
  catalog,
  effectLspDevDeps,
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
  pnpm: {
    patchedDependencies: pnpmPatchedDependencies(),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@effect/platform-node',
      '@effect/vitest',
      '@overeng/utils-dev',
      '@types/node',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
