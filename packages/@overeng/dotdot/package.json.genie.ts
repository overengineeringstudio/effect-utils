import {
  catalog,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  'effect',
] as const

export default packageJson({
  name: '@overeng/dotdot',
  ...privatePackageDefaults,
  scripts: {
    postinstall: patchPostinstall(),
  },
  exports: {
    '.': './src/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './cli': './dist/cli.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/utils'),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@effect/vitest',
      '@types/bun',
      '@types/node',
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
