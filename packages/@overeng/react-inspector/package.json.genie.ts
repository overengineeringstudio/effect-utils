import { pkg } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/react-inspector',
  /** Forked from react-inspector v8.0.0 (https://github.com/nicksenger/react-inspector) */
  version: '8.0.0',
  description: 'Power of Browser DevTools inspectors right inside your React app',
  type: 'module',
  exports: {
    '.': './src/index.tsx',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.cjs',
        import: './dist/index.js',
      },
    },
  },
  dependencies: ['is-dom'],
  devDependencies: [
    '@storybook/react',
    '@storybook/react-vite',
    '@testing-library/react',
    '@testing-library/user-event',
    '@types/is-dom',
    '@types/react',
    '@vitejs/plugin-react',
    'effect',
    'happy-dom',
    'react',
    'react-dom',
    'storybook',
    'vite',
    'vitest',
  ],
  peerDependencies: {
    effect: '^',
    react: '^',
  },
  peerDependenciesMeta: {
    effect: {
      optional: true,
    },
  },
})
