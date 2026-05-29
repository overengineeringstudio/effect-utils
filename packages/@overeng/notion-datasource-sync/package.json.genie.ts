import {
  catalog,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/cluster',
  '@effect/experimental',
  '@effect/opentelemetry',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  '@effect/workflow',
  '@playwright/test',
  'effect',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-datasource-sync' }),
  dependencies: {
    workspace: [notionEffectClientPkg, notionMdPkg, tuiReactPkg, utilsPkg],
    external: catalog.pick('react'),
  },
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect-atom/atom',
        '@effect-atom/atom-react',
        '@effect/vitest',
        '@opentui/core',
        '@opentui/react',
        '@storybook/react',
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        'react-dom',
        'react-reconciler',
        'typescript',
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
    name: '@overeng/notion-datasource-sync',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
    },
    engines: {
      node: '>=24.0.0',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'notion-datasource-sync': './dist/src/cli/main.js',
      },
      exports: {
        '.': './dist/src/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
