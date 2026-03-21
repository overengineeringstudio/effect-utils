import {
  catalog,
  packageJson,
  workspaceMember,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const composition = catalog.compose({
  workspace: workspaceMember({ memberPath: 'context/effect/socket' }),
  dependencies: {
    external: catalog.pick('@effect/platform', '@effect/platform-node', '@effect/rpc', 'effect'),
  },
  devDependencies: {
    external: catalog.pick('@types/node'),
  },
})

export default packageJson(
  {
    name: 'effect-socket-examples',
    private: true,
    type: 'module',
  } satisfies PackageJsonData,
  composition,
)
