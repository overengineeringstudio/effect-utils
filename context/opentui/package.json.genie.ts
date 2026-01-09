import { pkg } from '../../genie/repo.ts'

export default pkg({
  name: 'opentui-examples',
  private: true,
  type: 'module',
  dependencies: [
    '@effect-atom/atom',
    '@effect-atom/atom-react',
    '@opentui/core',
    '@opentui/react',
    'effect',
    'react',
  ],
  devDependencies: ['@types/node', '@types/react'],
})
