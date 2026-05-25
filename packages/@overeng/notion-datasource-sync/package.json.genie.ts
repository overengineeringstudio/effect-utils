import {
  catalog,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-datasource-sync' }),
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
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/mod.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
