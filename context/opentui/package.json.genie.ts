import {
  catalog,
  packageJson,
  workspaceMember,
  type PackageJsonData,
} from '../../genie/internal.ts'

const composition = catalog.compose({
  workspace: workspaceMember('context/opentui'),
  dependencies: {
    external: catalog.pick(
      '@effect-atom/atom',
      '@effect-atom/atom-react',
      '@opentui/core',
      '@opentui/react',
      'effect',
      'react',
    ),
  },
  devDependencies: {
    external: catalog.pick('@types/node', '@types/react'),
  },
})

export default packageJson(
  {
    name: 'opentui-examples',
    private: true,
    type: 'module',
    pnpm: {
      overrides: {
        // Force version alignment for Effect ecosystem packages
        // @effect-atom/atom brings in older versions as transitive deps
        // TODO: Remove once new @effect-atom/atom is released
        // https://github.com/tim-smart/effect-atom/issues/401
        ...catalog.pick('effect', '@effect/platform', '@effect/experimental', '@effect/rpc'),
      },
    },
  } satisfies PackageJsonData,
  composition,
)
