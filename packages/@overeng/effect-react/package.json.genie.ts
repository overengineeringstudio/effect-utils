import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
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
  devDependencies: {
    '@storybook/react': catalogRef,
    '@storybook/react-vite': catalogRef,
    '@types/react': catalogRef,
    '@vitejs/plugin-react': catalogRef,
    effect: catalogRef,
    react: catalogRef,
    'react-aria-components': catalogRef,
    'react-dom': catalogRef,
    storybook: catalogRef,
    vite: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    effect: catalogRef,
    react: catalogRef,
    'react-aria-components': catalogRef,
    'react-dom': catalogRef,
  },
})
