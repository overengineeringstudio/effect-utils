import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  'effect',
] as const

const tuiReactPeerNames = Object.keys(tuiReactPkg.data.peerDependencies ?? {})

const deps = catalog.compose({
  dir: import.meta.dirname,
  workspace: [effectPathPkg, tuiReactPkg, utilsPkg],
  external: catalog.pick('react'),
  workspaceSupport: [tuiCorePkg],
})

export default packageJson(
  {
    name: '@overeng/megarepo',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6007',
      'storybook:build': 'storybook build',
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
    dependencies: deps.dependencies,
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
    devDependencies: {
      ...catalog.pick(
        ...peerDepNames,
        ...tuiReactPeerNames,
        '@effect/vitest',
        '@types/bun',
        '@types/node',
        '@types/react',
        'vitest',
        'storybook',
        '@storybook/react',
        '@storybook/react-vite',
        '@xterm/xterm',
        '@xterm/addon-fit',
        'react-dom',
        'react-reconciler',
        'vite',
        '@vitejs/plugin-react',
      ),
      ...effectLspDevDeps(),
    },
    peerDependencies: {
      ...utilsPkg.data.peerDependencies,
      ...tuiReactPkg.data.peerDependencies,
      ...catalog.peers(...peerDepNames),
    },
  } satisfies PackageJsonData,
  {
    workspace: deps.workspace,
  },
)
