// @genie-phase bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import notionPropertyWritePkg from '../notion-property-write/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
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
    workspace: [
      contentAddressPkg,
      notionCorePkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      notionMdPkg,
      notionPropertyWritePkg,
      otelContractPkg,
      tuiReactPkg,
      utilsPkg,
    ],
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
      '.': exportEntry('./src/mod.ts', { environment: 'node' }),
      './body': exportEntry('./src/body/adapter.ts', { environment: 'node' }),
      './body/notion-md': exportEntry('./src/body/notion-md.ts', { environment: 'node' }),
      './cli/effect-command': exportEntry('./src/cli/effect-command.ts', { environment: 'node' }),
      './daemon': exportEntry('./src/daemon/watch.ts', { environment: 'node' }),
      './demo': exportEntry('./src/demo/live-demo.ts', { environment: 'node' }),
      './gateway': exportEntry('./src/gateway/gateway.ts', { environment: 'node' }),
      './gateway/fake': exportEntry('./src/gateway/fake.ts', { environment: 'node' }),
      './gateway/notion': exportEntry('./src/gateway/notion.ts', { environment: 'node' }),
      './local': exportEntry('./src/local/workspace.ts', { environment: 'node' }),
      './observability': exportEntry('./src/observability/observability.ts', {
        environment: 'node',
      }),
      './replica': exportEntry('./src/replica/replica.ts', { environment: 'node' }),
      './store': exportEntry('./src/store/store.ts', { environment: 'node' }),
      './store/projections': exportEntry('./src/store/projections.ts', { environment: 'node' }),
      './store/schema': exportEntry('./src/store/schema.ts', { environment: 'node' }),
      './sync': exportEntry('./src/sync/sync.ts', { environment: 'node' }),
      './sync/executor': exportEntry('./src/sync/executor.ts', { environment: 'node' }),
      './sync/observation': exportEntry('./src/sync/observation.ts', { environment: 'node' }),
      './testing/*': exportEntry('./src/testing/*.ts', { environment: 'node' }),
      './webhook': exportEntry('./src/webhook/mod.ts', { environment: 'node' }),
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
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
