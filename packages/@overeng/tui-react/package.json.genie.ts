import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = [
  'effect',
  'react',
  'react-dom',
  'react-reconciler',
  '@effect/platform-node',
  '@effect/cli',
] as const
const effectAtomDeps = ['@effect-atom/atom', '@effect-atom/atom-react'] as const
const opentuiDeps = ['@opentui/core', '@opentui/react'] as const

export default packageJson({
  name: '@overeng/tui-react',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.tsx',
    './storybook': './src/storybook/mod.tsx',
    './opentui': './src/effect/opentui/mod.tsx',
  },
  scripts: {
    storybook: 'storybook dev -p 6006',
    'storybook:build': 'storybook build',
    'test:e2e': 'playwright test',
    'test:e2e:ui': 'playwright test --ui',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './storybook': './dist/storybook/mod.js',
      './opentui': './dist/effect/opentui/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('yoga-layout', 'string-width', 'cli-truncate', '@overeng/tui-core'),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      // TypeScript & testing
      '@types/node',
      '@types/react',
      '@types/react-reconciler',
      'typescript',
      'vitest',
      '@playwright/test',
      '@overeng/utils',
      // Effect ecosystem
      'effect',
      '@effect/platform',
      // Effect Atom (state management)
      ...effectAtomDeps,
      // OpenTUI (alternate screen mode - requires Bun)
      ...opentuiDeps,
      // Storybook
      'storybook',
      '@storybook/react',
      '@storybook/react-vite',
      // xterm (terminal emulator for browser/testing)
      '@xterm/xterm',
      '@xterm/headless',
      '@xterm/addon-fit',
      // Build tools
      'vite',
      '@vitejs/plugin-react',
    ),
  },
  peerDependencies: catalog.peers(...peerDepNames, ...effectAtomDeps, ...opentuiDeps),
})
