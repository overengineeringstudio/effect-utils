import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/cli',
  '@effect/cluster',
  '@effect/experimental',
  '@effect/opentelemetry',
  '@effect/platform',
  '@effect/platform-node',
  '@effect/rpc',
  '@effect/workflow',
  '@playwright/test',
  'effect',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-md' }),
  dependencies: {
    workspace: [
      contentAddressPkg,
      notionCorePkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      otelContractPkg,
      utilsPkg,
    ],
    external: catalog.pick(
      'remark-gfm',
      'remark-parse',
      'remark-stringify',
      'unified',
      'unist-util-visit',
    ),
  },
  devDependencies: {
    workspace: [tuiReactPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect-atom/atom',
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        '@vitejs/plugin-react',
        'react',
        'react-dom',
        'react-reconciler',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/notion-md',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './cli': './src/cli.ts',
      './cli-program': './src/cli-program.ts',
    },
    scripts: {
      storybook: 'storybook dev -p 6015',
      'storybook:build': 'storybook build',
      'test:integration': 'vitest run --config vitest.integration.config.ts',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'notion-md': './dist/src/cli.js',
      },
      exports: {
        '.': './dist/src/mod.js',
        './cli': './dist/src/cli.js',
        './cli-program': './dist/src/cli-program.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
