import { pnpmPatchedDependencies } from '../../../genie/external.ts'
import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/** Runtime + type peer deps — consumers must have these to use and type-check tui-react's .tsx source exports */
const peerDepNames = [
  'effect',
  'react',
  'react-dom',
  'react-reconciler',
  '@effect/platform-node',
  '@effect/cli',
  /** Required for consumers to type-check imported .tsx source (not compiled .d.ts) */
  '@types/react',
  '@types/react-reconciler',
] as const
const effectAtomDeps = ['@effect-atom/atom', '@effect-atom/atom-react'] as const
const opentuiDeps = ['@opentui/core', '@opentui/react'] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/tui-react'),
  dependencies: {
    workspace: [tuiCorePkg],
    external: catalog.pick(
      'yoga-layout',
      'string-width',
      'cli-truncate',
      '@xterm/xterm',
      '@xterm/headless',
      '@xterm/addon-fit',
      '@xterm/addon-webgl',
    ),
  },
  pnpm: {
    patchedDependencies: pnpmPatchedDependencies(),
  },
  devDependencies: {
    workspace: [utilsPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        'vitest',
        '@effect/vitest',
        '@playwright/test',
        'effect',
        '@effect/platform',
        ...effectAtomDeps,
        ...opentuiDeps,
        'storybook',
        '@storybook/react',
        '@storybook/react-vite',
        'vite',
        '@vitejs/plugin-react',
        'typescript',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames, ...effectAtomDeps, ...opentuiDeps),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/tui-react',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.tsx',
      './node': './src/node/mod.ts',
      './storybook': './src/storybook/mod.tsx',
      './opentui': './src/effect/opentui/mod.tsx',
    },
    scripts: {
      storybook: 'storybook dev -p 6006',
      'storybook:build': 'storybook build',
      'test:e2e': 'playwright test',
      'test:e2e:ui': 'playwright test --ui',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './node': './dist/node/mod.js',
        './storybook': './dist/storybook/mod.js',
        './opentui': './dist/effect/opentui/mod.js',
      },
    },
  } satisfies PackageJsonData,
  runtimeDeps,
)
