import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/notion-effect-client',
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
  dependencies: {
    '@overeng/notion-effect-schema': 'workspace:*',
  },
  devDependencies: {
    '@effect/platform': catalogRef,
    '@effect/vitest': catalogRef,
    '@overeng/utils': 'workspace:*',
    '@types/node': catalogRef,
    effect: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/platform': catalogRef,
    effect: catalogRef,
  },
})
