import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import kdlPkg from '../kdl/package.json.genie.ts'
import kdlEffectPkg from '../kdl-effect/package.json.genie.ts'
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

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/megarepo'),
  dependencies: {
    workspace: [effectPathPkg, kdlPkg, kdlEffectPkg, tuiReactPkg, utilsPkg],
    external: catalog.pick('react'),
  },
  devDependencies: {
    workspace: [tuiCorePkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
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
        'typescript',
        'vite',
        '@vitejs/plugin-react',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick(...peerDepNames),
  },
  mode: 'install',
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
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
