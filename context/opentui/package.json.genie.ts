import { catalog, packageJson } from '../../genie/internal.ts'

export default packageJson({
  name: 'opentui-examples',
  private: true,
  type: 'module',
  dependencies: {
    ...catalog.pick(
      '@effect-atom/atom',
      '@effect-atom/atom-react',
      '@opentui/core',
      '@opentui/react',
      'effect',
      'react',
    ),
  },
  devDependencies: {
    ...catalog.pick('@types/node', '@types/react'),
  },
})
