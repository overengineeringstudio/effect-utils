import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  name: '@overeng/genie',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
    storybook: 'storybook dev -p 6008',
    'storybook:build': 'storybook build',
  },
  exports: {
    '.': './src/runtime/mod.ts',
    './cli': './src/build/mod.tsx',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/src/runtime/mod.js',
      './cli': './dist/src/build/mod.js',
    },
  },
  // Genie must not use any runtime dependencies (only bundled/dev dependencies)
  dependencies: {},
  devDependencies: {
    ...utilsPkg.data.peerDependencies,
    ...tuiReactPkg.data.peerDependencies,
    ...catalog.pick(
      '@overeng/utils',
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
      // Storybook (addon-essentials is built into storybook 10.x)
      '@storybook/react',
      '@storybook/react-vite',
      'storybook',
      '@types/react',
      '@types/react-reconciler',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/utils peer deps transitively (consumers need them)
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers('@effect/cli'),
  },
})
