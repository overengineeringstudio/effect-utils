import { catalogRef } from '../../../genie/repo.ts'
import { packageJSON } from '../genie/src/lib/mod.ts'

export default packageJSON({
  name: '@overeng/effect-schema-form',
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
    '@types/react': catalogRef,
    effect: catalogRef,
    react: catalogRef,
    vitest: catalogRef,
  },
  peerDependencies: {
    effect: catalogRef,
    react: catalogRef,
  },
})
