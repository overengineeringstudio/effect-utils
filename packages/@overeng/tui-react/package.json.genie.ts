import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/tui-react',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
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
  },
  peerDependencies: {
    effect: catalog.pick('effect').effect,
  },
  peerDependenciesMeta: {
    effect: { optional: true },
  },
})
