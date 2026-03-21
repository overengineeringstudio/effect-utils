import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-effect-client' }),
  dependencies: {
    workspace: [notionEffectSchemaPkg],
  },
  devDependencies: {
    workspace: [utilsDevPkg, utilsPkg],
    external: {
      ...catalog.pick(
        '@effect/platform',
        '@effect/vitest',
        '@types/node',
        'effect',
        'typescript',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg],
  },
})

export default packageJson(
  {
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
  },
  runtimeDeps,
)
