// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import corePkg from '../effect-rpc-explorer/package.json.genie.ts'
import stylexTokensPkg from '../stylex-tokens/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react', 'react-aria-components', 'react-dom'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-rpc-explorer-react' }),
  dependencies: {
    workspace: [corePkg, stylexTokensPkg],
    external: catalog.pick('@stylexjs/stylex'),
  },
  devDependencies: {
    workspace: [utilsPkg],
    external: catalog.pick(
      ...peerDepNames,
      '@storybook/react',
      '@storybook/addon-a11y',
      '@vitest/browser',
      '@vitest/browser-playwright',
      'playwright',
      '@storybook/react-vite',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'storybook',
      'typescript',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-rpc-explorer-react',
    ...privatePackageDefaults,
    description: 'Dense, policy-safe React explorer for @overeng/effect-rpc-explorer',
    exports: {
      '.': exportEntry(
        { types: './dist/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './styles.css': exportEntry('./src/styles.css', { environment: 'browser' }),
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
        '.': './dist/mod.js',
        './styles.css': './dist/styles.css',
        './tokens.stylex': './dist/tokens.stylex.js',
        './themes': './dist/themes.js',
      },
    },
    scripts: {
      build: 'tsc --build tsconfig.json && vite build',
      storybook: 'storybook dev -p 6017',
      'storybook:build': 'storybook build',
      gate: 'bun node_modules/@overeng/utils/src/node/storybook/gate/cli.ts',
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
