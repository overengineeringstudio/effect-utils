import { catalogRef } from '../../../../../genie/repo.ts'
import { packageJSON } from '../../../genie/src/lib/mod.ts'

export default packageJSON({
  name: 'effect-rpc-tanstack-example-basic',
  version: '0.1.0',
  private: true,
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'vite build',
    start: 'node .output/server/index.mjs',
    'test:e2e': 'playwright test',
  },
  dependencies: {
    '@effect/platform': catalogRef,
    '@effect/rpc': catalogRef,
    '@tanstack/react-router': catalogRef,
    '@tanstack/react-start': catalogRef,
    effect: catalogRef,
    react: catalogRef,
    'react-dom': catalogRef,
  },
  devDependencies: {
    '@playwright/test': catalogRef,
    '@tanstack/router-plugin': catalogRef,
    '@types/node': catalogRef,
    '@types/react': catalogRef,
    '@types/react-dom': catalogRef,
    '@vitejs/plugin-react': catalogRef,
    typescript: catalogRef,
    vite: catalogRef,
  },
})
