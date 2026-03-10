import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const inheritedPeerDepNames = [
  ...new Set([
    ...Object.keys(utilsPkg.data.peerDependencies ?? {}),
    ...Object.keys(tuiReactPkg.data.peerDependencies ?? {}),
  ]),
]

const deps = catalog.compose({
  dir: import.meta.dirname,
  workspaceSupport: [tuiCorePkg, tuiReactPkg, utilsDevPkg, utilsPkg],
})

export default packageJson(
  {
    name: '@overeng/genie',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6008',
      'storybook:build': 'storybook build',
    },
    exports: {
      '.': './src/runtime/mod.ts',
      './cli': './src/build/mod.tsx',
      './sdk': './src/sdk/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/runtime/mod.js',
        './cli': './dist/src/build/mod.js',
        './sdk': './dist/src/sdk/mod.js',
      },
    },
    dependencies: {},
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
    devDependencies: {
      ...catalog.pick(
        ...inheritedPeerDepNames,
        '@overeng/utils',
        '@overeng/utils-dev',
        '@overeng/tui-react',
        '@effect/cli',
        '@effect/platform',
        '@effect/platform-node',
        '@effect/printer',
        '@effect/printer-ansi',
        '@effect/vitest',
        '@types/node',
        '@types/bun',
        'vitest',
        '@storybook/react',
        '@storybook/react-vite',
        'storybook',
        '@types/react',
        '@types/react-reconciler',
        'prettier',
        'oxfmt',
      ),
      ...effectLspDevDeps(),
    },
    peerDependencies: {
      ...utilsPkg.data.peerDependencies,
      ...catalog.peers('@effect/cli'),
    },
  } satisfies PackageJsonData,
  {
    workspace: deps.workspace,
  },
)
