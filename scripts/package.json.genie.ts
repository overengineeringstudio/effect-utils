import { catalogRef } from '../genie/repo.ts'
import { packageJSON } from '../packages/@overeng/genie/src/lib/mod.ts'

export default packageJSON({
  name: 'effect-utils-scripts',
  private: true,
  type: 'module',
  dependencies: {
    '@effect/cli': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@overeng/genie': 'workspace:*',
    '@overeng/utils': 'workspace:*',
    effect: catalogRef,
  },
  devDependencies: {
    '@types/node': catalogRef,
    typescript: '^5.9.3',
  },
})
