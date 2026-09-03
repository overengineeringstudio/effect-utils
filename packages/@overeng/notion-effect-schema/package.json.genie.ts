// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-effect-schema' }),
  dependencies: {
    workspace: [notionCorePkg],
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
    name: '@overeng/notion-effect-schema',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
