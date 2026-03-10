import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['@effect/platform', 'effect'] as const

const deps = catalog.compose({
  dir: import.meta.dirname,
  workspaceSupport: [utilsDevPkg],
})

export default packageJson(
  {
    name: '@overeng/effect-path',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
    devDependencies: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/platform-node',
        '@effect/vitest',
        '@overeng/utils-dev',
        '@types/node',
        'vitest',
      ),
      ...effectLspDevDeps(),
    },
    peerDependencies: catalog.peers(...peerDepNames),
  } satisfies PackageJsonData,
  {
    workspace: deps.workspace,
  },
)
