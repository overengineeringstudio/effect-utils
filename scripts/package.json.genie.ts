import { catalog, packageJson } from '../genie/internal.ts'
import utilsPkg from '../packages/@overeng/utils/package.json.genie.ts'

export default packageJson({
  name: 'effect-utils-scripts',
  private: true,
  type: 'module',
  dependencies: {
    ...catalog.pick(
      '@overeng/genie',
      '@overeng/mono',
      '@overeng/utils',
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      'effect',
    ),
  },
  devDependencies: {
    ...catalog.pick('@types/node', 'typescript'),
  },
  patchedDependencies: {
    ...utilsPkg.data.patchedDependencies,
  },
})
