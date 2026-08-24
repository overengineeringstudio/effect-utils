// @genie-bootstrap
import {
  catalog,
  packageJson,
  workspaceMember,
  type PackageJsonData,
} from '../../genie/internal.ts'

const composition = catalog.compose({
  workspace: workspaceMember({ memberPath: 'context/opentui' }),
  dependencies: {
    external: catalog.pick(
      '@effect/atom-react',
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
  } satisfies PackageJsonData,
  composition,
)
