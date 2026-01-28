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
    ...catalog.pick('react'),
    'react-reconciler': '^0.32.0', // React custom renderer API
    'yoga-layout': '^3.2.1', // Flexbox layout engine (pure JS, no native bindings)
    'string-width': '^7.2.0', // Accurate string width for Unicode/emoji
    '@overeng/tui-core': 'workspace:*',
  },
  devDependencies: {
    ...catalog.pick(
      '@types/node',
      '@types/react',
      'typescript',
      'vitest',
      'effect', // For TuiRenderer service
      '@effect/platform', // For terminal integration
    ),
    '@types/react-reconciler': '^0.28.9', // Types for react-reconciler
    '@xterm/headless': '^5.5.0', // Virtual terminal for testing
    // Storybook dependencies
    storybook: '^8.6.0', // Storybook core
    '@storybook/react': '^8.6.0', // Storybook React renderer
    '@storybook/react-vite': '^8.6.0', // Storybook Vite builder for React
    '@storybook/addon-essentials': '^8.6.0', // Essential addons (controls, docs, etc.)
    '@xterm/xterm': '^5.5.0', // Terminal emulator for browser
    '@xterm/addon-fit': '^0.10.0', // Auto-fit terminal to container
    ...catalog.pick('react-dom'), // For storybook web rendering
    vite: '^6.0.0', // Build tool for storybook
    '@vitejs/plugin-react': '^4.0.0', // React plugin for Vite
  },
  peerDependencies: {
    effect: catalog.pick('effect').effect,
  },
  peerDependenciesMeta: {
    effect: { optional: true },
  },
})
