import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  'effect',
] as const

export default packageJson({
  name: '@overeng/megarepo',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
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
  dependencies: {
    ...catalog.pick(
      '@overeng/utils',
      '@overeng/cli-ui',
      '@overeng/effect-path',
      '@overeng/tui-react',
      'react',
    ),
  },
  devDependencies: {
    ...catalog.pick(
      // Peer deps (for testing)
      ...peerDepNames,
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
      'vite',
      '@vitejs/plugin-react',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers(...peerDepNames),
  },
})
