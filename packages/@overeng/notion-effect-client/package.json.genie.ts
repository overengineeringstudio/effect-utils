import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const data = {
  name: '@overeng/notion-effect-client',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './test': './src/test/integration/setup.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/notion-effect-schema'),
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/platform',
      '@effect/vitest',
      '@overeng/utils',
      '@overeng/utils-dev',
      '@types/node',
      'effect',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  // Expose @overeng/utils peer deps transitively (consumers need them)
  peerDependencies: utilsPkg.data.peerDependencies,
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [notionEffectSchemaPkg, utilsDevPkg, utilsPkg],
    location: 'packages/@overeng/notion-effect-client',
  }),
} satisfies PackageJsonData)
