import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
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
    workspace: [notionEffectClientPkg, notionEffectSchemaPkg, utilsPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg],
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
    name: '@overeng/notion-md',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
    },
    scripts: {
      'test:integration': 'vitest run --config vitest.integration.config.ts',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'notion-md': './dist/src/cli.js',
      },
      exports: {
        '.': './dist/src/mod.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
