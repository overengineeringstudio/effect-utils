import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/effect-react',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './react-aria': './src/react-aria/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './react-aria': './dist/react-aria/mod.js',
    },
  },
  devDependencies: {
    ...catalog.pick(
      '@storybook/react',
      '@storybook/react-vite',
      '@types/react',
      '@vitejs/plugin-react',
      'effect',
      'react',
      'react-aria-components',
      'react-dom',
      'storybook',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    effect: `^${catalog.effect}`,
    react: `^${catalog.react}`,
    'react-aria-components': `^${catalog['react-aria-components']}`,
    'react-dom': `^${catalog['react-dom']}`,
  },
})
