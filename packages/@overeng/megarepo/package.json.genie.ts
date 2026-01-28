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
    ...catalog.pick('@overeng/utils', '@overeng/cli-ui', '@overeng/effect-path', '@overeng/tui-react', 'react'),
  },
  devDependencies: {
    ...catalog.pick(...peerDepNames, '@effect/vitest', '@types/bun', '@types/node', '@types/react', 'vitest'),
    ...effectLspDevDeps(),
    // Storybook dependencies
    storybook: '^8.6.0',
    '@storybook/react': '^8.6.0',
    '@storybook/react-vite': '^8.6.0',
    '@storybook/addon-essentials': '^8.6.0',
    '@xterm/xterm': '^5.5.0',
    '@xterm/addon-fit': '^0.10.0',
    ...catalog.pick('react-dom'),
    vite: '^6.0.0',
    '@vitejs/plugin-react': '^4.0.0',
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers(...peerDepNames),
  },
})
