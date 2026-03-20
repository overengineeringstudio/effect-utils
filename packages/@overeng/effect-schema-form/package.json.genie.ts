import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const peerDepNames = ['effect', 'react'] as const
const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-schema-form' }),
  devDependencies: {
    external: {
      ...catalog.pick(...peerDepNames, '@types/react', 'typescript', 'vitest'),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-schema-form',
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
  deps,
)
