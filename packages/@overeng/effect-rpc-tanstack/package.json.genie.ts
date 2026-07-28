// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', '@effect/platform-node', '@tanstack/react-router', '@tanstack/react-start', 'react', 'react-dom'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({
    memberPath: 'packages/@overeng/effect-rpc-tanstack',
    pnpmPackageClosure: {
      extraMemberPaths: ['packages/@overeng/effect-rpc-tanstack/examples/basic'],
    },
  }),
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(...peerDepNames, 'effect', '@types/react', 'typescript', 'vite', 'vitest'),
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
      '.': exportEntry('./src/mod.ts', { environment: 'browser' }),
      './client': exportEntry('./src/client.ts', { environment: 'browser' }),
      './server': exportEntry('./src/server.ts', { environment: 'node' }),
      './router': exportEntry('./src/router.ts', { environment: 'browser' }),
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
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
