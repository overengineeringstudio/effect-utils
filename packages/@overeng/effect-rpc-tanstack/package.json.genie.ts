import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const peerDepNames = [
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  '@tanstack/react-router',
  '@tanstack/react-start',
  'effect',
  'react',
  'react-dom',
] as const

export default packageJson({
  name: '@overeng/effect-rpc-tanstack',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './client': './src/client.ts',
    './server': './src/server.ts',
    './router': './src/router.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './client': './dist/client.js',
      './server': './dist/server.js',
      './router': './dist/router.js',
    },
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@effect/experimental',
      '@effect/sql',
      '@types/react',
      'vite',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
