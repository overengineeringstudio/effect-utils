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

const supportDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/genie'),
  devDependencies: {
    workspace: [tuiCorePkg, tuiReactPkg, utilsDevPkg, utilsPkg],
    external: {
      ...catalog.pick(
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
        'typescript',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick('@effect/cli'),
  },
  mode: 'install',
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
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  supportDeps,
)
