// @genie-bootstrap
import { otelSdkDeps } from '../../../genie/external.ts'
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import effectDistributedLockPkg from '../effect-distributed-lock/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

/** Packages exposed as peer deps (consumers provide) + included in devDeps (for local dev/test) */
const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/platform-node',
  '@playwright/test',
  'effect',
] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/utils' }),
  dependencies: {
    workspace: [effectDistributedLockPkg, otelContractPkg],
    external: {
      ...catalog.pick(
        '@noble/hashes',
        '@opentelemetry/api',
        // StyleX build integration (`./node/stylex`) lives here rather than in the
        // browser-pure token package — VRS stylex R11/R12, decision 0006.
        '@stylexjs/unplugin',
        'unplugin',
      ),
      postcss: '8.5.26',
    },
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        ...otelSdkDeps,
        '@effect/vitest',
        '@types/node',
        'playwright',
        'typescript',
        'vite',
        'vitest',
        // Next.js fixture for the `./node/stylex/next` adapter's build test:
        // the fixture app assembles its node_modules by symlinking from this
        // package's installed graph. The app, not the shared catalog, selects
        // its own Next.js version.
        'babel-loader',
        '@babel/core',
        '@stylexjs/babel-plugin',
        '@stylexjs/postcss-plugin',
        '@stylexjs/stylex',
        'react',
        'react-dom',
        '@types/react',
      ),
      next: '16.2.6',
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
      '.': exportEntry(
        { types: './dist/src/isomorphic/mod.d.ts', default: './src/isomorphic/mod.ts' },
        { environment: 'node' },
      ),
      './node': exportEntry(
        { types: './dist/src/node/mod.d.ts', default: './src/node/mod.ts' },
        { environment: 'node' },
      ),
      './node/cli-help-rewrite': exportEntry(
        {
          types: './dist/src/node/cli-help-rewrite.d.ts',
          default: './src/node/cli-help-rewrite.ts',
        },
        { environment: 'node' },
      ),
      './node/cli-version': exportEntry(
        {
          types: './dist/src/node/cli-version.d.ts',
          default: './src/node/cli-version.ts',
        },
        { environment: 'node' },
      ),
      './node/otel': exportEntry(
        { types: './dist/src/node/otel.d.ts', default: './src/node/otel.ts' },
        { environment: 'node' },
      ),
      './node/otel-attrs': exportEntry(
        { types: './dist/src/node/otel-attrs.d.ts', default: './src/node/otel-attrs.ts' },
        { environment: 'node' },
      ),
      './node/playwright': exportEntry(
        {
          types: './dist/src/node/playwright/mod.d.ts',
          default: './src/node/playwright/mod.ts',
        },
        { environment: 'node' },
      ),
      './node/playwright/config': exportEntry(
        {
          types: './dist/src/node/playwright/config/mod.d.ts',
          default: './src/node/playwright/config/mod.ts',
        },
        { environment: 'node' },
      ),
      // Checked JavaScript, not TypeScript: Vite loads config files through
      // Node, which refuses TypeScript stripping for packages under
      // `node_modules`. See #1167.
      './node/stylex': exportEntry(
        {
          types: './src/node/stylex/mod-types.d.ts',
          default: './src/node/stylex/mod.js',
        },
        { environment: 'node' },
      ),
      // Checked JavaScript for the same reason as `./node/stylex`: Next loads
      // next.config.mjs / postcss.config.mjs through Node, which refuses
      // TypeScript stripping for packages under `node_modules` (#1167).
      './node/stylex/next': exportEntry(
        {
          types: './src/node/stylex/next-types.d.ts',
          default: './src/node/stylex/next.js',
        },
        { environment: 'node' },
      ),
      // Audits a BUILT stylesheet for the StyleX `:focus-visible` priority
      // defect. Its own entry because it is a check to be run, in CI or by
      // hand, and a validated detector left in a docs folder never gets run.
      './node/stylex/focus-order': exportEntry(
        {
          types: './dist/src/node/stylex/focus-order.d.ts',
          default: './src/node/stylex/focus-order.ts',
        },
        { environment: 'node' },
      ),
      './lock': exportEntry(
        { types: './dist/src/lock/mod.d.ts', default: './src/lock/mod.ts' },
        { environment: 'node' },
      ),
      './browser': exportEntry(
        { types: './dist/src/browser/mod.d.ts', default: './src/browser/mod.ts' },
        { environment: 'browser' },
      ),
      './cuid': exportEntry(
        {
          types: './dist/src/cuid/mod.d.ts',
          browser: './src/cuid/cuid.browser.ts',
          node: './src/cuid/cuid.node.ts',
          default: './src/cuid/mod.ts',
        },
        [{ environment: 'browser' }, { environment: 'node' }],
      ),
    },

    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/isomorphic/mod.d.ts', default: './dist/src/isomorphic/mod.js' },
        './node': { types: './dist/src/node/mod.d.ts', default: './dist/src/node/mod.js' },
        './node/cli-help-rewrite': {
          types: './dist/src/node/cli-help-rewrite.d.ts',
          default: './dist/src/node/cli-help-rewrite.js',
        },
        './node/cli-version': {
          types: './dist/src/node/cli-version.d.ts',
          default: './dist/src/node/cli-version.js',
        },
        './node/otel': { types: './dist/src/node/otel.d.ts', default: './dist/src/node/otel.js' },
        './node/otel-attrs': {
          types: './dist/src/node/otel-attrs.d.ts',
          default: './dist/src/node/otel-attrs.js',
        },
        './node/playwright': {
          types: './dist/src/node/playwright/mod.d.ts',
          default: './dist/src/node/playwright/mod.js',
        },
        './node/playwright/config': {
          types: './dist/src/node/playwright/config/mod.d.ts',
          default: './dist/src/node/playwright/config/mod.js',
        },
        './node/stylex': {
          types: './src/node/stylex/mod-types.d.ts',
          default: './src/node/stylex/mod.js',
        },
        './node/stylex/next': {
          types: './src/node/stylex/next-types.d.ts',
          default: './src/node/stylex/next.js',
        },
        './node/stylex/focus-order': {
          types: './dist/src/node/stylex/focus-order.d.ts',
          default: './dist/src/node/stylex/focus-order.js',
        },
        './lock': { types: './dist/src/lock/mod.d.ts', default: './dist/src/lock/mod.js' },
        './browser': { types: './dist/src/browser/mod.d.ts', default: './dist/src/browser/mod.js' },
        './cuid': {
          types: './dist/src/cuid/mod.d.ts',
          browser: './dist/src/cuid/cuid.browser.js',
          node: './dist/src/cuid/cuid.node.js',
          default: './dist/src/cuid/mod.js',
        },
      },
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
