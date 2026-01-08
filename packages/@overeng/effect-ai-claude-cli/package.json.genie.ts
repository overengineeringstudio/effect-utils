import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/effect-ai-claude-cli',
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
    '@effect/ai': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/vitest': catalogRef,
    effect: catalogRef,
    vite: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    '@effect/ai': '>=0.32.0',
    '@effect/platform': '>=0.93.0',
    effect: '>=3.19.0',
  },
})
