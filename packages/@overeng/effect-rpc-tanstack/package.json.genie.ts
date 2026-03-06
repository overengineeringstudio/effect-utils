import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'
import examplePkg from './examples/basic/package.json.genie.ts'

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

const data = {
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
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [examplePkg, utilsPkg],
    location: 'packages/@overeng/effect-rpc-tanstack',
    extraPackages: ['examples/basic'],
  }),
} satisfies PackageJsonData)
