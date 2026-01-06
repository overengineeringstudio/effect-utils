import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/utils',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/isomorphic/mod.ts',
    './node': './src/node/mod.ts',
    './node/playwright': './src/node/playwright/mod.ts',
    './browser': './src/browser/mod.ts',
    './cuid': {
      browser: './src/cuid/cuid.browser.ts',
      node: './src/cuid/cuid.node.ts',
      default: './src/cuid/mod.ts',
    },
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/isomorphic/mod.js',
      './node': './dist/node/mod.js',
      './node/playwright': './dist/node/playwright/mod.js',
      './browser': './dist/browser/mod.js',
      './cuid': {
        browser: './dist/cuid/cuid.browser.js',
        node: './dist/cuid/cuid.node.js',
        default: './dist/cuid/mod.js',
      },
    },
  },
  dependencies: {
    '@noble/hashes': '1.7.1',
    '@opentelemetry/api': catalogRef,
    'effect-distributed-lock': catalogRef,
  },
  devDependencies: {
    '@effect/opentelemetry': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    '@effect/vitest': catalogRef,
    '@playwright/test': catalogRef,
    '@types/node': catalogRef,
    effect: catalogRef,
    vite: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/opentelemetry': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    '@playwright/test': catalogRef,
    effect: catalogRef,
  },
})
