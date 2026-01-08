import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/effect-rpc-tanstack',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
    './client': './src/client.ts',
    './server': './src/server.ts',
    './router': './src/router.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './client': './dist/client.js',
      './server': './dist/server.js',
      './router': './dist/router.js',
    },
  },
  devDependencies: {
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    '@tanstack/react-router': catalogRef,
    '@tanstack/react-start': catalogRef,
    '@types/react': catalogRef,
    effect: catalogRef,
    react: catalogRef,
    'react-dom': catalogRef,
    vite: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    '@tanstack/react-router': catalogRef,
    '@tanstack/react-start': catalogRef,
    effect: catalogRef,
    react: catalogRef,
    'react-dom': catalogRef,
  },
})
