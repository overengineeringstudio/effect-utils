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
/* Storybook gate entries are optional; the consumer supplies its own Storybook runtime. */
const storybookGatePeers = [
  '@storybook/react-vite',
  '@vitest/browser-playwright',
  'storybook',
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
        'storybook',
        '@storybook/react-vite',
        // Story-gate stack. These stay devDependencies for the same reason
        // Storybook itself does: a consumer that runs the gate necessarily owns
        // its own Storybook install, and making them real dependencies would
        // put Storybook in the closure of everything that depends on utils.
        // The browser packages pin Vitest exactly, so the three move together.
        '@storybook/addon-a11y',
        '@vitest/browser',
        '@vitest/browser-playwright',
        'playwright',
        'typescript',
        'vite',
        'vitest',
        // Next.js fixture for the `./node/stylex/next` adapter's build test:
        // the fixture app assembles its node_modules by symlinking from this
        // package's installed graph. The app, not the shared catalog, selects
        // its own Next.js version.
        'babel-loader',
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
    external: catalog.pick(...peerDepNames, ...storybookGatePeers),
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
      './node/storybook': exportEntry(
        { types: './dist/src/node/storybook/mod.d.ts', default: './src/node/storybook/mod.ts' },
        { environment: 'node' },
      ),
      './node/storybook/config': exportEntry(
        {
          types: './dist/src/node/storybook/config/mod.d.ts',
          default: './src/node/storybook/config/mod.ts',
        },
        { environment: 'node' },
      ),
      './node/storybook/gate': exportEntry(
        {
          types: './dist/src/node/storybook/gate/mod.d.ts',
          default: './src/node/storybook/gate/mod.ts',
        },
        { environment: 'node' },
      ),
      './node/storybook/gate/cli': exportEntry(
        {
          types: './dist/src/node/storybook/gate/cli.d.ts',
          default: './src/node/storybook/gate/cli.ts',
        },
        { environment: 'node' },
      ),
      // Referenced by path from the gate's `test.setupFiles`, never imported
      // from Node: it runs inside the Vitest browser environment.
      './node/storybook/gate/setup': exportEntry(
        {
          types: './dist/src/node/storybook/gate/setup.d.ts',
          default: './src/node/storybook/gate/setup.ts',
        },
        { environment: 'browser' },
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
        './node/storybook': {
          types: './dist/src/node/storybook/mod.d.ts',
          default: './dist/src/node/storybook/mod.js',
        },
        './node/storybook/config': {
          types: './dist/src/node/storybook/config/mod.d.ts',
          default: './dist/src/node/storybook/config/mod.js',
        },
        './node/storybook/gate': {
          types: './dist/src/node/storybook/gate/mod.d.ts',
          default: './dist/src/node/storybook/gate/mod.js',
        },
        './node/storybook/gate/cli': {
          types: './dist/src/node/storybook/gate/cli.d.ts',
          default: './dist/src/node/storybook/gate/cli.js',
        },
        './node/storybook/gate/setup': {
          types: './dist/src/node/storybook/gate/setup.d.ts',
          default: './dist/src/node/storybook/gate/setup.js',
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
    peerDependenciesMeta: Object.fromEntries(
      storybookGatePeers.map((name) => [name, { optional: true }]),
    ),
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
