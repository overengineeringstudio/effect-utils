import { otelSdkDeps } from '../../../genie/external.ts'
import {
  catalog,
  definePatchedDependencies,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/experimental',
  '@effect/cluster',
  '@effect/workflow',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/printer',
  '@effect/printer-ansi',
  '@effect/rpc',
  '@playwright/test',
  'effect',
] as const

const utilsPatches = definePatchedDependencies({
  location: 'packages/@overeng/utils',
  patches: {
    'effect-distributed-lock@0.0.11': './patches/effect-distributed-lock@0.0.11.patch',
  },
})

export default packageJson({
  name: '@overeng/utils',
  ...privatePackageDefaults,
  scripts: {
    ...effectLspScripts,
  },
  pnpm: {
    patchedDependencies: utilsPatches,
  },
  exports: {
    '.': './src/isomorphic/mod.ts',
    './node': './src/node/mod.ts',
    './node/cli-version': './src/node/cli-version.ts',
    './node/playwright': './src/node/playwright/mod.ts',
    // Separate config export avoids runtime @playwright/test import.
    './node/playwright/config': './src/node/playwright/config/mod.ts',
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
      './node/playwright/config': './dist/node/playwright/config/mod.js',
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
      '@overeng/tui-core',
      'effect-distributed-lock',
      'ioredis',
    ),
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
