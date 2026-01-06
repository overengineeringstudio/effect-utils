import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../../../packages/@overeng/genie/src/lib/mod.ts'

export default packageJSON({
  name: 'effect-socket-examples',
  private: true,
  type: 'module',
  dependencies: {
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    effect: catalogRef,
  },
  devDependencies: {
    '@types/node': catalogRef,
  },
})
