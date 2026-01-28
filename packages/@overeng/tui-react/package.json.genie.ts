import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/tui-react',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './storybook': './src/storybook/mod.ts',
  },
  scripts: {
    storybook: 'storybook dev -p 6006',
    'storybook:build': 'storybook build',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './storybook': './dist/storybook/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick(
      'react',
      'react-reconciler',
      'yoga-layout',
      'string-width',
      '@overeng/tui-core',
    ),
  },
  devDependencies: {
    ...catalog.pick(
      // TypeScript & testing
      '@types/node',
      '@types/react',
      '@types/react-reconciler',
      'typescript',
      'vitest',
      // Effect ecosystem
      'effect',
      '@effect/platform',
      // Storybook
      'storybook',
      '@storybook/react',
      '@storybook/react-vite',
      // xterm (terminal emulator for browser/testing)
      '@xterm/xterm',
      '@xterm/headless',
      '@xterm/addon-fit',
      // Build tools
      'react-dom',
      'vite',
      '@vitejs/plugin-react',
    ),
  },
  peerDependencies: {
    effect: catalog.pick('effect').effect,
  },
  peerDependenciesMeta: {
    effect: { optional: true },
  },
})
