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
    'yoga-layout': '^3.2.1', // Flexbox layout engine (pure JS, no native bindings)
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
    '@xterm/headless': '^5.5.0', // Virtual terminal for testing
  },
  peerDependencies: {
    effect: catalog.pick('effect').effect,
  },
  peerDependenciesMeta: {
    effect: { optional: true },
  },
})
