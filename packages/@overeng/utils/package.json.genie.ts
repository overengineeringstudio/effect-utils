import { catalog, packageJson, patchPostinstall, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/utils',
  ...privatePackageDefaults,
  scripts: {
    postinstall: patchPostinstall(),
  },
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
  dependencies: {
    ...catalog.pick(
      '@noble/hashes',
      '@opentelemetry/api',
      'effect-distributed-lock',
      'ioredis',
    ),
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/opentelemetry',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/printer',
      '@effect/printer-ansi',
      '@effect/rpc',
      '@effect/vitest',
      '@playwright/test',
      '@types/node',
      'effect',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    '@effect/opentelemetry': `^${catalog['@effect/opentelemetry']}`,
    '@effect/platform': `^${catalog['@effect/platform']}`,
    '@effect/platform-node': `^${catalog['@effect/platform-node']}`,
    '@effect/printer': `^${catalog['@effect/printer']}`,
    '@effect/printer-ansi': `^${catalog['@effect/printer-ansi']}`,
    '@effect/rpc': `^${catalog['@effect/rpc']}`,
    '@playwright/test': `^${catalog['@playwright/test']}`,
    effect: `^${catalog.effect}`,
  },
})
