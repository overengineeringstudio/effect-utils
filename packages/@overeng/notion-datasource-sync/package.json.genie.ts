import {
  catalog,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
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
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-datasource-sync' }),
  dependencies: {
    workspace: [notionEffectClientPkg, notionEffectSchemaPkg, notionMdPkg, tuiReactPkg, utilsPkg],
    external: catalog.pick('react'),
  },
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect-atom/atom',
        '@effect-atom/atom-react',
        '@effect/vitest',
        '@opentui/core',
        '@opentui/react',
        '@storybook/react',
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        'react-dom',
        'react-reconciler',
        'typescript',
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
    name: '@overeng/notion-datasource-sync',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './body': './src/body/adapter.ts',
      './body/notion-md': './src/body/notion-md.ts',
      './cli/effect-command': './src/cli/effect-command.ts',
      './daemon': './src/daemon/watch.ts',
      './demo': './src/demo/live-demo.ts',
      './gateway': './src/gateway/gateway.ts',
      './gateway/fake': './src/gateway/fake.ts',
      './gateway/notion': './src/gateway/notion.ts',
      './local': './src/local/workspace.ts',
      './observability': './src/observability/observability.ts',
      './replica': './src/replica/replica.ts',
      './store': './src/store/store.ts',
      './store/projections': './src/store/projections.ts',
      './store/schema': './src/store/schema.ts',
      './sync': './src/sync/sync.ts',
      './sync/executor': './src/sync/executor.ts',
      './sync/observation': './src/sync/observation.ts',
      './testing/*': './src/testing/*.ts',
      './webhook': './src/webhook/mod.ts',
    },
    scripts: {
      'demo:verify':
        'NOTION_DATASOURCE_SYNC_LIVE=1 vitest run src/e2e/live-demo-replica.e2e.test.ts --config vitest.config.ts',
      'demo:verify:full':
        'NOTION_DATASOURCE_SYNC_LIVE=1 NOTION_DATASOURCE_SYNC_FULL_DEMO=1 vitest run src/e2e/live-demo-replica.e2e.test.ts --config vitest.config.ts',
      'demo:provision':
        'NOTION_DATASOURCE_SYNC_LIVE=1 NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES=data_source_retrieve,data_source_query,data_source_metadata_update,page_retrieve,page_property_paginate,page_create vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts -t "credentialed automated demo showcase"',
    },
    engines: {
      node: '>=24.0.0',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/mod.js',
        './body': './dist/src/body/adapter.js',
        './body/notion-md': './dist/src/body/notion-md.js',
        './cli/effect-command': './dist/src/cli/effect-command.js',
        './daemon': './dist/src/daemon/watch.js',
        './demo': './dist/src/demo/live-demo.js',
        './gateway': './dist/src/gateway/gateway.js',
        './gateway/fake': './dist/src/gateway/fake.js',
        './gateway/notion': './dist/src/gateway/notion.js',
        './local': './dist/src/local/workspace.js',
        './observability': './dist/src/observability/observability.js',
        './replica': './dist/src/replica/replica.js',
        './store': './dist/src/store/store.js',
        './store/projections': './dist/src/store/projections.js',
        './store/schema': './dist/src/store/schema.js',
        './sync': './dist/src/sync/sync.js',
        './sync/executor': './dist/src/sync/executor.js',
        './sync/observation': './dist/src/sync/observation.js',
        './testing/*': './dist/src/testing/*.js',
        './webhook': './dist/src/webhook/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
