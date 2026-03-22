import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const ownPeerDepNames = ['@effect/cli'] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/tui-stories' }),
  dependencies: {
    workspace: [tuiCorePkg, tuiReactPkg, utilsPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(...ownPeerDepNames, '@effect/vitest', '@types/react', 'typescript', 'vitest'),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick(...ownPeerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/tui-stories',
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
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
