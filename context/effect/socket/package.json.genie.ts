import { catalog, packageJson, type PackageJsonData } from '../../../genie/internal.ts'

export default packageJson({
  name: 'effect-socket-examples',
  private: true,
  type: 'module',
  dependencies: {
    ...catalog.pick('@effect/platform', '@effect/platform-node', '@effect/rpc', 'effect'),
  },
  devDependencies: {
    ...catalog.pick('@types/node'),
  },
} satisfies PackageJsonData)
