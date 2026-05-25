import {
  catalog,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'

const peerDepNames = [
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
    workspace: [notionEffectClientPkg],
  },
  devDependencies: {
    external: {
      ...catalog.pick(...peerDepNames, '@effect/vitest', '@types/node', 'typescript', 'vitest'),
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
    },
    engines: {
      node: '>=24.0.0',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'notion-datasource-sync': './dist/src/cli.js',
      },
      exports: {
        '.': './dist/src/mod.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
