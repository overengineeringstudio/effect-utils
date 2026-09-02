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
    external: catalog.pick(
      '@noble/hashes',
      '@opentelemetry/api',
      // StyleX build integration (`./node/stylex`) lives here rather than in the
      // browser-pure token package — VRS stylex R11/R12, decision 0006.
      '@stylexjs/unplugin',
      'unplugin',
    ),
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
        // @vitest/browser pins `vitest` at exactly 4.1.9, so these five move in
        // lockstep with the vitest pin.
        '@storybook/addon-vitest',
        '@storybook/addon-a11y',
        '@vitest/browser',
        '@vitest/browser-playwright',
        'playwright',
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
      '.': exportEntry('./src/isomorphic/mod.ts', { environment: 'node' }),
      './node': exportEntry('./src/node/mod.ts', { environment: 'node' }),
      './node/cli-help-rewrite': exportEntry('./src/node/cli-help-rewrite.ts', {
        environment: 'node',
      }),
      './node/cli-version': exportEntry('./src/node/cli-version.ts', { environment: 'node' }),
      './node/otel': exportEntry('./src/node/otel.ts', { environment: 'node' }),
      './node/otel-attrs': exportEntry('./src/node/otel-attrs.ts', { environment: 'node' }),
      './node/playwright': exportEntry('./src/node/playwright/mod.ts', { environment: 'node' }),
      './node/playwright/config': exportEntry('./src/node/playwright/config/mod.ts', {
        environment: 'node',
      }),
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
      // Audits a BUILT stylesheet for the StyleX `:focus-visible` priority
      // defect. Its own entry because it is a check to be run, in CI or by
      // hand, and a validated detector left in a docs folder never gets run.
      './node/stylex/focus-order': exportEntry('./src/node/stylex/focus-order.ts', {
        environment: 'node',
      }),
      './node/storybook': exportEntry('./src/node/storybook/mod.ts', { environment: 'node' }),
      './node/storybook/config': exportEntry('./src/node/storybook/config/mod.ts', {
        environment: 'node',
      }),
      './node/storybook/gate': exportEntry('./src/node/storybook/gate/mod.ts', {
        environment: 'node',
      }),
      './node/storybook/gate/cli': exportEntry('./src/node/storybook/gate/cli.ts', {
        environment: 'node',
      }),
      // Referenced by path from the gate's `test.setupFiles`, never imported
      // from Node: it runs inside the Vitest browser environment.
      './node/storybook/gate/setup': exportEntry('./src/node/storybook/gate/setup.ts', {
        environment: 'browser',
      }),
      './lock': exportEntry('./src/lock/mod.ts', { environment: 'node' }),
      './browser': exportEntry('./src/browser/mod.ts', { environment: 'browser' }),
      './cuid': exportEntry(
        {
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
        '.': './dist/isomorphic/mod.js',
        './node': './dist/node/mod.js',
        './node/cli-help-rewrite': './dist/node/cli-help-rewrite.js',
        './node/cli-version': './dist/node/cli-version.js',
        './node/otel': './dist/node/otel.js',
        './node/otel-attrs': './dist/node/otel-attrs.js',
        './node/playwright': './dist/node/playwright/mod.js',
        './node/playwright/config': './dist/node/playwright/config/mod.js',
        './node/stylex': './dist/node/stylex/mod.js',
        './node/stylex/focus-order': './dist/node/stylex/focus-order.js',
        './node/storybook': './dist/node/storybook/mod.js',
        './node/storybook/config': './dist/node/storybook/config/mod.js',
        './node/storybook/gate': './dist/node/storybook/gate/mod.js',
        './node/storybook/gate/cli': './dist/node/storybook/gate/cli.js',
        './node/storybook/gate/setup': './dist/node/storybook/gate/setup.js',
        './lock': './dist/lock/mod.js',
        './browser': './dist/browser/mod.js',
        './cuid': {
          browser: './dist/cuid/cuid.browser.js',
          node: './dist/cuid/cuid.node.js',
          default: './dist/cuid/mod.js',
        },
      },
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
