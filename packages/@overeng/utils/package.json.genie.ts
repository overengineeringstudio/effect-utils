import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  patchPostinstall,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import { otelSdkDeps } from '../../../genie/external.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  '@effect/rpc',
  '@playwright/test',
  'effect',
] as const

export default packageJson({
  name: '@overeng/utils',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
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
    ...catalog.pick('@noble/hashes', '@opentelemetry/api', 'effect-distributed-lock', 'ioredis'),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      // Peer deps of @effect/opentelemetry (needed for local dev/test)
      ...otelSdkDeps,
      // Dev-only deps
      '@effect/vitest',
      '@types/node',
      'vite',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
