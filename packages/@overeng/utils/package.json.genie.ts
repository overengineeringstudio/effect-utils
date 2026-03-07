import { otelSdkDeps, pnpmPatchedDependencies } from '../../../genie/external.ts'
import {
  catalog,
  utilsPatches,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/experimental',
  '@effect/cluster',
  '@effect/workflow',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  '@playwright/test',
  'effect',
] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/utils'),
  dependencies: {
    external: catalog.pick(
      '@noble/hashes',
      '@opentelemetry/api',
      'effect-distributed-lock',
      'ioredis',
    ),
  },
  pnpm: {
    patchedDependencies: pnpmPatchedDependencies(),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        ...otelSdkDeps,
        '@effect/vitest',
        '@types/node',
        'storybook',
        '@storybook/react-vite',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/utils',
    ...privatePackageDefaults,
    exports: {
      '.': './src/isomorphic/mod.ts',
      './node': './src/node/mod.ts',
      './node/cli-help-rewrite': './src/node/cli-help-rewrite.ts',
      './node/cli-version': './src/node/cli-version.ts',
      './node/otel': './src/node/otel.ts',
      './node/playwright': './src/node/playwright/mod.ts',
      './node/playwright/config': './src/node/playwright/config/mod.ts',
      './node/storybook': './src/node/storybook/mod.ts',
      './node/storybook/config': './src/node/storybook/config/mod.ts',
      './browser': './src/browser/mod.ts',
      './cuid': {
        browser: './src/cuid/cuid.browser.ts',
        node: './src/cuid/cuid.node.ts',
        default: './src/cuid/mod.ts',
      },
    },
    pnpm: {
      patchedDependencies: utilsPatches,
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/isomorphic/mod.js',
        './node': './dist/node/mod.js',
        './node/cli-help-rewrite': './dist/node/cli-help-rewrite.js',
        './node/cli-version': './dist/node/cli-version.js',
        './node/otel': './dist/node/otel.js',
        './node/playwright': './dist/node/playwright/mod.js',
        './node/playwright/config': './dist/node/playwright/config/mod.js',
        './node/storybook': './dist/node/storybook/mod.js',
        './node/storybook/config': './dist/node/storybook/config/mod.js',
        './browser': './dist/browser/mod.js',
        './cuid': {
          browser: './dist/cuid/cuid.browser.js',
          node: './dist/cuid/cuid.node.js',
          default: './dist/cuid/mod.js',
        },
      },
    },
  } satisfies PackageJsonData,
  runtimeDeps,
)
