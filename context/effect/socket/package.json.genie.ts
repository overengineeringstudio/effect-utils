import { pkg } from '../../../genie/repo.ts'

export default pkg.package({
  name: 'effect-socket-examples',
  private: true,
  type: 'module',
  dependencies: ['@effect/platform', '@effect/platform-node', '@effect/rpc', 'effect'],
  devDependencies: ['@types/node'],
})
