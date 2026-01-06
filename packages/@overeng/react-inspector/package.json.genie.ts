import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/react-inspector',
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
    'is-dom': '1.1.0',
  },
  devDependencies: {
    '@storybook/react': catalogRef,
    '@storybook/react-vite': catalogRef,
    '@testing-library/react': '16.3.1',
    '@testing-library/user-event': '14.6.1',
    '@types/is-dom': '1.1.2',
    '@types/react': catalogRef,
    '@vitejs/plugin-react': catalogRef,
    effect: catalogRef,
    'happy-dom': '18.0.1',
    react: catalogRef,
    'react-dom': catalogRef,
    storybook: catalogRef,
    vite: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    effect: catalogRef,
    react: catalogRef,
  },
  peerDependenciesMeta: {
    effect: {
      optional: true,
    },
  },
})
