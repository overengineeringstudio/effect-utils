import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/pty-effect' }),
  dependencies: {
    external: catalog.pick('@myobie/pty'),
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
    name: '@overeng/pty-effect',
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
  } satisfies PackageJsonData,
  workspaceDeps,
)
