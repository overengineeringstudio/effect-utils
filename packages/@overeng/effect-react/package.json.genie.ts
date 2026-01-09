import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/effect-react',
  version: '0.1.0',
  private: true,
  type: 'module',
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
  devDependencies: [
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
  ],
  peerDependencies: {
    effect: '^',
    react: '^',
    'react-aria-components': '^',
    'react-dom': '^',
  },
})
