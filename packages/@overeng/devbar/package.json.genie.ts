// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import explorerReactPkg from '../effect-rpc-explorer-react/package.json.genie.ts'
import explorerPkg from '../effect-rpc-explorer/package.json.genie.ts'
import observerPkg from '../effect-rpc-observer/package.json.genie.ts'
import metersPkg from '../meters/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import rpcDevtoolsPkg from '../rpc-devtools/package.json.genie.ts'
import stylexTokensPkg from '../stylex-tokens/package.json.genie.ts'
import utilsStorybookPkg from '../utils-storybook/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['@stylexjs/stylex', 'react', 'react-dom'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/devbar' }),
  dependencies: { workspace: [stylexTokensPkg] },
  devDependencies: {
    workspace: [
      utilsPkg,
      utilsStorybookPkg,
      metersPkg,
      rpcDevtoolsPkg,
      explorerPkg,
      observerPkg,
      explorerReactPkg,
      otelContractPkg,
    ],
    external: catalog.pick(
      ...peerDepNames,
      'effect',
      '@effect/platform-node',
      '@effect/vitest',
      '@storybook/react',
      '@storybook/addon-a11y',
      '@vitest/browser',
      '@vitest/browser-playwright',
      'playwright',
      '@storybook/react-vite',
      '@testing-library/react',
      '@testing-library/user-event',
      'happy-dom',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'storybook',
      'typescript',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: { external: catalog.pick(...peerDepNames) },
})

export default packageJson(
  {
    name: '@overeng/devbar',
    ...privatePackageDefaults,
    description:
      'Host-composed developer shell with panel, strip, and status slots for React applications',
    exports: {
      '.': exportEntry(
        { types: './dist/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './tokens.stylex': exportEntry(
        { types: './dist/tokens.stylex.d.ts', default: './src/tokens.stylex.ts' },
        { environment: 'browser' },
      ),
      './themes': exportEntry(
        { types: './dist/themes.d.ts', default: './src/themes.ts' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/mod.d.ts', default: './dist/mod.js' },
        './tokens.stylex': {
          types: './dist/tokens.stylex.d.ts',
          default: './dist/tokens.stylex.js',
        },
        './themes': { types: './dist/themes.d.ts', default: './dist/themes.js' },
      },
    },
    scripts: {
      build: 'tsc --build tsconfig.json && vite build',
      storybook: 'storybook dev -p 6018',
      'storybook:build': 'storybook build',
      gate: 'bun node_modules/@overeng/utils-storybook/src/gate/cli.ts',
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
