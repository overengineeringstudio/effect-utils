import { catalog, packageJson } from '../../../genie/internal.ts'

export default packageJson({
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
  dependencies: {
    'is-dom': catalog['is-dom'],
  },
  devDependencies: {
    '@storybook/react': catalog['@storybook/react'],
    '@storybook/react-vite': catalog['@storybook/react-vite'],
    '@testing-library/react': catalog['@testing-library/react'],
    '@testing-library/user-event': catalog['@testing-library/user-event'],
    '@types/is-dom': catalog['@types/is-dom'],
    '@types/react': catalog['@types/react'],
    '@vitejs/plugin-react': catalog['@vitejs/plugin-react'],
    effect: catalog.effect,
    'happy-dom': catalog['happy-dom'],
    react: catalog.react,
    'react-dom': catalog['react-dom'],
    storybook: catalog.storybook,
    vite: catalog.vite,
    vitest: catalog.vitest,
  },
  peerDependencies: {
    effect: `^${catalog.effect}`,
    react: `^${catalog.react}`,
  },
  peerDependenciesMeta: {
    effect: {
      optional: true,
    },
  },
})
