import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const data = {
  name: '@overeng/notion-effect-schema',
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
      '@effect/vitest',
      '@overeng/utils-dev',
      '@types/node',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [utilsDevPkg],
    location: 'packages/@overeng/notion-effect-schema',
  }),
} satisfies PackageJsonData)
