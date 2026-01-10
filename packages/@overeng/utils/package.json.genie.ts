import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
  name: '@overeng/utils',
  ...privatePackageDefaults,
  exports: {
    '.': './src/isomorphic/mod.ts',
    './node': './src/node/mod.ts',
    './node/cli-version': './src/node/cli-version.ts',
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
      './node/cli-version': './dist/node/cli-version.js',
      './node/playwright': './dist/node/playwright/mod.js',
      './browser': './dist/browser/mod.js',
      './cuid': {
        browser: './dist/cuid/cuid.browser.js',
        node: './dist/cuid/cuid.node.js',
        default: './dist/cuid/mod.js',
      },
    },
  },
  dependencies: ['@noble/hashes', '@opentelemetry/api', 'effect-distributed-lock', 'ioredis'],
  devDependencies: [
    '@effect/opentelemetry',
    '@effect/platform',
    '@effect/platform-node',
    '@effect/rpc',
    '@effect/vitest',
    '@playwright/test',
    '@types/node',
    'effect',
    'vite',
    'vitest',
  ],
  peerDependencies: {
    '@effect/opentelemetry': '^',
    '@effect/platform': '^',
    '@effect/platform-node': '^',
    '@effect/rpc': '^',
    '@playwright/test': '^',
    effect: '^',
  },
})
