import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/effect-path',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  devDependencies: {
    '@effect/platform': catalogRef,
    '@effect/vitest': catalogRef,
    '@types/node': catalogRef,
    effect: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/platform': catalogRef,
    effect: catalogRef,
  },
})
