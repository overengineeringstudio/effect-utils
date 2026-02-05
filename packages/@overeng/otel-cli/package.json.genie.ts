import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['@effect/cli', '@effect/platform', '@effect/platform-node', 'effect'] as const

const tuiReactPeerNames = Object.keys(tuiReactPkg.data.peerDependencies ?? {})

export default packageJson({
  name: '@overeng/otel-cli',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
    storybook: 'storybook dev -p 6013',
    'storybook:build': 'storybook build',
  },
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    bin: {
      otel: './dist/bin/otel.js',
    },
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/tui-core', '@overeng/tui-react', '@overeng/utils'),
  },
  dependenciesMeta: {
    '@overeng/tui-react': { injected: true },
  },
  devDependencies: {
    ...catalog.pick(
      // Peer deps (for testing)
      ...peerDepNames,
      ...tuiReactPeerNames,
      // Testing
      '@effect/vitest',
      '@types/bun',
      '@types/node',
      '@types/react',
      'vitest',
      // Storybook
      'storybook',
      '@storybook/react',
      '@storybook/react-vite',
      // xterm (terminal emulator for Storybook)
      '@xterm/xterm',
      '@xterm/addon-fit',
      // Build tools
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
  pnpm: {
    patchedDependencies: {
      ...utilsPkg.data.pnpm?.patchedDependencies,
      ...tuiReactPkg.data.pnpm?.patchedDependencies,
    },
  },
} satisfies PackageJsonData)
