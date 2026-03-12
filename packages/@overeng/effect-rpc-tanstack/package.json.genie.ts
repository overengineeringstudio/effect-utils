import {
  catalog,
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
const workspaceDeps = catalog.compose({
  dir: import.meta.dirname,
  devDependencies: {
    workspace: [examplePkg, utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/experimental',
        '@effect/sql',
        '@types/react',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
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
  } satisfies PackageJsonData,
  workspaceDeps,
)
