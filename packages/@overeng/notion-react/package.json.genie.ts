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

const peerDepNames = ['effect', 'react', 'react-reconciler'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-react' }),
  dependencies: {
    workspace: [notionEffectClientPkg, notionEffectSchemaPkg],
    external: catalog.pick('@effect/platform'),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/vitest',
        '@types/react',
        '@types/react-reconciler',
        'typescript',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg],
    external: catalog.pick(...peerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-react',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './renderer': './src/renderer/mod.ts',
      './test': './src/test/integration/setup.ts',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './renderer': './dist/renderer/mod.js',
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
